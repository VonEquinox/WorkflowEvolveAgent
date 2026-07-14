"""Deterministic, event-driven dynamic DAG scheduler simulator.

The simulator intentionally depends only on the Python standard library.  It is
small enough for correctness experiments, while preserving the invariants from
``research/reports/03_DYNAMIC_DAG_SCHEDULER.md``:

* an unsealed node is never dispatched;
* an incoming edge cannot be added after a node is sealed;
* graph mutations are cycle checked;
* terminal events propagate only to direct consumers;
* resource capacity is reserved before dispatch and reconciled afterwards;
* a logical node can commit a result at most once; and
* cancellation changes the attempt generation so late results are rejected.

Time is virtual.  Events with the same timestamp are processed in insertion
order, which makes every run deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import heapq
import math
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Sequence,
    Tuple,
    Union,
)


_EPSILON = 1e-9
_UNSET = object()


class SchedulerError(Exception):
    """Base class for scheduler errors."""


class GraphMutationError(SchedulerError, ValueError):
    """Base class for invalid graph mutations."""


class DuplicateNodeError(GraphMutationError):
    """Raised when ADD_NODE reuses an existing logical node id."""


class UnknownNodeError(SchedulerError, KeyError):
    """Raised when an operation references an unknown node."""


class LateEdgeError(GraphMutationError):
    """Raised when ADD_EDGE targets a sealed or otherwise frozen node."""


class DuplicateEdgeError(GraphMutationError):
    """Raised when the same directed edge is added twice."""


class CycleError(GraphMutationError):
    """Raised when a graph mutation would introduce a directed cycle."""


class InvalidTriggerError(GraphMutationError):
    """Raised for an invalid trigger rule or quorum."""


class ResourceAdmissionError(SchedulerError):
    """Raised when a caller attempts an infeasible reservation directly."""


class NodeState(Enum):
    DECLARED = "DECLARED"
    WAITING_DEPS = "WAITING_DEPS"
    READY_LOGICAL = "READY_LOGICAL"
    READY = "READY_LOGICAL"  # concise alias used by the report pseudocode
    ADMISSION_WAIT = "ADMISSION_WAIT"
    RUNNING = "RUNNING"
    RETRY_WAIT = "RETRY_WAIT"
    CANCELLING = "CANCELLING"
    SUCCEEDED = "SUCCEEDED"
    FAILED_FINAL = "FAILED_FINAL"
    FAILED = "FAILED_FINAL"  # concise alias used by the report pseudocode
    CANCELLED = "CANCELLED"
    SKIPPED = "SKIPPED"


TERMINAL_STATES = frozenset(
    {
        NodeState.SUCCEEDED,
        NodeState.FAILED_FINAL,
        NodeState.CANCELLED,
        NodeState.SKIPPED,
    }
)


class TriggerRule(Enum):
    ALL_SUCCESS = "ALL_SUCCESS"
    ALL_DONE = "ALL_DONE"
    ANY_SUCCESS = "ANY_SUCCESS"
    QUORUM = "QUORUM"


@dataclass(frozen=True)
class TriggerSpec:
    """A trigger rule plus its optional quorum threshold."""

    rule: TriggerRule = TriggerRule.ALL_SUCCESS
    quorum: Optional[int] = None

    @classmethod
    def quorum_of(cls, count: int) -> "TriggerSpec":
        return cls(TriggerRule.QUORUM, count)


class RetryClass(Enum):
    NEVER = "NEVER"
    TRANSIENT_ONLY = "TRANSIENT_ONLY"
    SAFE = "SAFE"


class EffectClass(Enum):
    PURE = "PURE"
    IDEMPOTENT = "IDEMPOTENT"
    IDEMPOTENT_WITH_KEY = "IDEMPOTENT_WITH_KEY"
    COMPENSATABLE = "COMPENSATABLE"
    NON_IDEMPOTENT = "NON_IDEMPOTENT"


class FailureKind(Enum):
    RATE_LIMITED = "RATE_LIMITED"
    RATE_LIMIT = "RATE_LIMITED"
    SERVER = "SERVER"
    TRANSIENT_SERVER = "SERVER"
    NETWORK = "NETWORK"
    NETWORK_PRE_CONNECT = "NETWORK"
    UNKNOWN_EFFECT = "UNKNOWN_EFFECT"
    INVALID_REQUEST = "INVALID_REQUEST"
    AUTHORIZATION = "AUTHORIZATION"
    AUTH = "AUTHORIZATION"
    FORMAT = "FORMAT"
    BUDGET = "BUDGET"
    DEADLINE = "DEADLINE"
    PERMANENT = "PERMANENT"
    CANCELLED = "CANCELLED"
    OTHER = "OTHER"


class RetryDisposition(Enum):
    RETRY = "RETRY"
    FAIL = "FAIL"
    RECONCILE = "RECONCILE"


class EdgeStatus(Enum):
    PENDING = "PENDING"
    SUCCESS = "SUCCESS"
    DONE_UNSUCCESSFUL = "DONE_UNSUCCESSFUL"


class EventType(Enum):
    # Public graph/control protocol.
    ADD_NODE = "ADD_NODE"
    ADD_EDGE = "ADD_EDGE"
    SEAL_NODE = "SEAL_NODE"
    CANCEL_NODE = "CANCEL_NODE"

    # Scheduler lifecycle/audit events.
    NODE_READY = "NODE_READY"
    ADMISSION_WAIT = "ADMISSION_WAIT"
    ATTEMPT_STARTED = "ATTEMPT_STARTED"
    ATTEMPT_SUCCEEDED = "ATTEMPT_SUCCEEDED"
    ATTEMPT_FAILED = "ATTEMPT_FAILED"
    RETRY_SCHEDULED = "RETRY_SCHEDULED"
    RETRY_READY = "RETRY_READY"
    RESULT_COMMITTED = "RESULT_COMMITTED"
    RESULT_REJECTED = "RESULT_REJECTED"
    NODE_FAILED = "NODE_FAILED"
    NODE_CANCELLED = "NODE_CANCELLED"
    DEPENDENCY_RESOLVED = "DEPENDENCY_RESOLVED"
    QUOTA_WAKE = "QUOTA_WAKE"
    CALLBACK = "CALLBACK"


EnumLike = Union[str, Enum]


def _coerce_enum(enum_type: Any, value: Any, label: str) -> Any:
    if isinstance(value, enum_type):
        return value
    if isinstance(value, Enum):
        value = value.value
    if isinstance(value, str):
        normalized = value.strip().upper().replace("-", "_").replace(" ", "_")
        try:
            return enum_type[normalized]
        except KeyError:
            for member in enum_type:
                if member.value == normalized:
                    return member
    raise ValueError("invalid {0}: {1!r}".format(label, value))


def _coerce_trigger(
    trigger_rule: Union[TriggerRule, TriggerSpec, str, Tuple[Any, int]],
    quorum: Optional[int],
) -> TriggerSpec:
    if isinstance(trigger_rule, TriggerSpec):
        if quorum is not None and trigger_rule.quorum != quorum:
            raise InvalidTriggerError("conflicting quorum values")
        spec = trigger_rule
    elif isinstance(trigger_rule, tuple) and len(trigger_rule) == 2:
        if quorum is not None and quorum != trigger_rule[1]:
            raise InvalidTriggerError("conflicting quorum values")
        spec = TriggerSpec(
            _coerce_enum(TriggerRule, trigger_rule[0], "trigger rule"),
            int(trigger_rule[1]),
        )
    elif isinstance(trigger_rule, str) and trigger_rule.strip().upper().startswith("QUORUM("):
        text = trigger_rule.strip()
        if not text.endswith(")"):
            raise InvalidTriggerError("invalid QUORUM syntax: {0!r}".format(trigger_rule))
        parsed = int(text[text.find("(") + 1 : -1])
        if quorum is not None and quorum != parsed:
            raise InvalidTriggerError("conflicting quorum values")
        spec = TriggerSpec(TriggerRule.QUORUM, parsed)
    else:
        rule = _coerce_enum(TriggerRule, trigger_rule, "trigger rule")
        spec = TriggerSpec(rule, quorum)

    if spec.rule is TriggerRule.QUORUM:
        if spec.quorum is None or not isinstance(spec.quorum, int) or spec.quorum < 1:
            raise InvalidTriggerError("QUORUM requires a positive integer threshold")
    elif spec.quorum is not None:
        raise InvalidTriggerError("quorum is only valid with the QUORUM trigger")
    return spec


@dataclass(frozen=True)
class Failure:
    kind: FailureKind
    message: str = ""
    retry_after: Optional[float] = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "kind",
            _coerce_enum(FailureKind, self.kind, "failure kind"),
        )
        if self.retry_after is not None and self.retry_after < 0:
            raise ValueError("retry_after must be non-negative")


def coerce_failure(value: Any) -> Failure:
    if isinstance(value, Failure):
        return value
    if isinstance(value, FailureKind):
        return Failure(value)
    if isinstance(value, str):
        try:
            return Failure(_coerce_enum(FailureKind, value, "failure kind"))
        except ValueError:
            return Failure(FailureKind.OTHER, value)
    if isinstance(value, BaseException):
        status_code = getattr(value, "status_code", None)
        if status_code == 429:
            kind = FailureKind.RATE_LIMITED
        elif isinstance(status_code, int) and 500 <= status_code <= 599:
            kind = FailureKind.SERVER
        elif isinstance(value, PermissionError):
            kind = FailureKind.AUTHORIZATION
        elif isinstance(value, (ConnectionError, TimeoutError)):
            kind = FailureKind.NETWORK
        elif isinstance(value, ValueError):
            kind = FailureKind.INVALID_REQUEST
        else:
            kind = FailureKind.OTHER
        return Failure(kind, str(value), getattr(value, "retry_after", None))
    raise TypeError("failure must be a Failure, FailureKind, string, or exception")


def classify_retry(
    failure: Any,
    retry_class: Union[RetryClass, str] = RetryClass.TRANSIENT_ONLY,
    effect_class: Union[EffectClass, str] = EffectClass.PURE,
) -> RetryDisposition:
    """Classify an error without consulting attempt/deadline budgets.

    UNKNOWN_EFFECT is retryable only for effects known to be idempotent.  An
    unsafe unknown effect is classified as RECONCILE, matching the report's
    requirement not to blindly retry ambiguous side effects.
    """

    failure = coerce_failure(failure)
    retry_class = _coerce_enum(RetryClass, retry_class, "retry class")
    effect_class = _coerce_enum(EffectClass, effect_class, "effect class")

    safe_effects = {
        EffectClass.PURE,
        EffectClass.IDEMPOTENT,
        EffectClass.IDEMPOTENT_WITH_KEY,
    }
    if failure.kind is FailureKind.UNKNOWN_EFFECT:
        if effect_class not in safe_effects:
            return RetryDisposition.RECONCILE
        if retry_class is RetryClass.NEVER:
            return RetryDisposition.FAIL
        return RetryDisposition.RETRY

    if retry_class is RetryClass.NEVER:
        return RetryDisposition.FAIL

    transient = {
        FailureKind.RATE_LIMITED,
        FailureKind.SERVER,
        FailureKind.NETWORK,
    }
    deterministic = {
        FailureKind.INVALID_REQUEST,
        FailureKind.AUTHORIZATION,
        FailureKind.BUDGET,
        FailureKind.DEADLINE,
        FailureKind.PERMANENT,
        FailureKind.CANCELLED,
    }
    if failure.kind in transient:
        return RetryDisposition.RETRY
    if failure.kind in deterministic:
        return RetryDisposition.FAIL
    if retry_class is RetryClass.SAFE:
        return RetryDisposition.RETRY
    return RetryDisposition.FAIL


@dataclass(frozen=True)
class AttemptOutcome:
    """Deterministic outcome used by one simulated execution attempt."""

    duration: float = 0.0
    result: Any = None
    error: Optional[Failure] = None
    actual_tokens: Optional[float] = None

    def __post_init__(self) -> None:
        if self.duration < 0:
            raise ValueError("attempt duration must be non-negative")
        if self.actual_tokens is not None and self.actual_tokens < 0:
            raise ValueError("actual_tokens must be non-negative")
        if self.error is not None:
            object.__setattr__(self, "error", coerce_failure(self.error))

    @classmethod
    def success(
        cls,
        result: Any = None,
        duration: float = 0.0,
        actual_tokens: Optional[float] = None,
    ) -> "AttemptOutcome":
        return cls(duration=duration, result=result, actual_tokens=actual_tokens)

    @classmethod
    def failure(
        cls,
        failure: Any,
        duration: float = 0.0,
        actual_tokens: Optional[float] = None,
    ) -> "AttemptOutcome":
        return cls(
            duration=duration,
            error=coerce_failure(failure),
            actual_tokens=actual_tokens,
        )

    failed = failure


@dataclass
class Edge:
    parent: "Node"
    child: "Node"
    status: EdgeStatus = EdgeStatus.PENDING

    @property
    def parent_id(self) -> str:
        return self.parent.id

    @property
    def child_id(self) -> str:
        return self.child.id


@dataclass
class Node:
    id: str
    trigger_rule: TriggerRule = TriggerRule.ALL_SUCCESS
    quorum: Optional[int] = None
    sealed: bool = False
    state: NodeState = NodeState.DECLARED
    incoming: List[Edge] = field(default_factory=list, repr=False)
    consumers: List[Edge] = field(default_factory=list, repr=False)
    required_total: int = 0
    required_satisfied: int = 0
    required_done: int = 0
    required_impossible: int = 0
    estimated_tokens: float = 0.0
    outcomes: Tuple[AttemptOutcome, ...] = field(default_factory=tuple, repr=False)
    max_attempts: int = 1
    retry_class: RetryClass = RetryClass.TRANSIENT_ONLY
    effect_class: EffectClass = EffectClass.PURE
    retry_backoff: float = 1.0
    auto_complete: bool = True
    on_success: Optional[Callable[["DynamicDAGScheduler", "Node", Any], None]] = field(
        default=None, repr=False
    )
    attempt: int = 0
    attempt_generation: int = 0
    attempt_start_times: List[float] = field(default_factory=list)
    completed_at: Optional[float] = None
    result: Any = None
    last_failure: Optional[Failure] = None
    needs_reconciliation: bool = False
    late_results_rejected: int = 0
    duplicate_results_rejected: int = 0
    _admission_order: Optional[int] = field(default=None, repr=False)
    _queued_for_admission: bool = field(default=False, repr=False)
    _reservations: Dict[int, "Reservation"] = field(default_factory=dict, repr=False)

    @property
    def outgoing(self) -> List[Edge]:
        return self.consumers

    @property
    def impossible(self) -> int:
        return self.required_impossible

    @property
    def active_predecessors(self) -> int:
        return self.required_total - self.required_done

    @property
    def is_terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    @property
    def generation(self) -> int:
        return self.attempt_generation

    @property
    def started_at(self) -> Optional[float]:
        return self.attempt_start_times[0] if self.attempt_start_times else None

    def outcome_for_attempt(self, attempt_number: int) -> AttemptOutcome:
        if not self.outcomes:
            return AttemptOutcome.success(self.id)
        index = min(max(attempt_number - 1, 0), len(self.outcomes) - 1)
        return self.outcomes[index]


class TokenBucket:
    """Continuous-refill token bucket driven by virtual time."""

    def __init__(self, capacity: Optional[float], window_seconds: float = 60.0) -> None:
        if capacity is not None and capacity < 0:
            raise ValueError("token bucket capacity must be non-negative or None")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be positive")
        self.capacity = None if capacity is None else float(capacity)
        self.window_seconds = float(window_seconds)
        self.tokens = math.inf if self.capacity is None else self.capacity
        self.last_refill = 0.0

    @property
    def refill_rate(self) -> float:
        if self.capacity is None:
            return math.inf
        return self.capacity / self.window_seconds

    def refill(self, now: float) -> None:
        if now + _EPSILON < self.last_refill:
            raise ValueError("virtual time cannot move backwards")
        if self.capacity is None:
            self.last_refill = now
            return
        elapsed = max(0.0, now - self.last_refill)
        if elapsed:
            self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_rate)
        self.last_refill = now

    def can_consume(self, amount: float, now: float) -> bool:
        if amount < 0:
            raise ValueError("token demand must be non-negative")
        self.refill(now)
        if self.capacity is None:
            return True
        if amount > self.capacity + _EPSILON:
            return False
        return self.tokens + _EPSILON >= amount

    def consume(self, amount: float, now: float) -> bool:
        if not self.can_consume(amount, now):
            return False
        if self.capacity is not None:
            self.tokens -= amount
            if abs(self.tokens) < _EPSILON:
                self.tokens = 0.0
        return True

    def time_until(self, amount: float, now: float) -> float:
        if amount < 0:
            raise ValueError("token demand must be non-negative")
        self.refill(now)
        if self.capacity is None or self.tokens + _EPSILON >= amount:
            return 0.0
        if amount > self.capacity + _EPSILON or self.refill_rate <= 0:
            return math.inf
        return max(0.0, (amount - self.tokens) / self.refill_rate)

    def refund(self, amount: float, now: float) -> None:
        if amount < 0:
            raise ValueError("refund must be non-negative")
        self.refill(now)
        if self.capacity is not None:
            self.tokens = min(self.capacity, self.tokens + amount)

    def charge(self, amount: float, now: float) -> None:
        """Charge post-hoc usage; debt is allowed when estimates were low."""

        if amount < 0:
            raise ValueError("charge must be non-negative")
        self.refill(now)
        if self.capacity is not None:
            self.tokens -= amount

    @property
    def available(self) -> float:
        return self.tokens


@dataclass(frozen=True)
class ResourceDemand:
    requests: float = 1.0
    tokens: float = 0.0

    def __post_init__(self) -> None:
        if self.requests < 0 or self.tokens < 0:
            raise ValueError("resource demand must be non-negative")


@dataclass
class Reservation:
    id: int
    node_id: str
    demand: ResourceDemand
    created_at: float
    active: bool = True


class ResourceManager:
    """Concurrency plus simplified RPM/TPM token-bucket admission."""

    def __init__(
        self,
        concurrency_limit: Optional[int] = None,
        rpm: Optional[float] = None,
        tpm: Optional[float] = None,
        window_seconds: float = 60.0,
    ) -> None:
        if concurrency_limit is not None and concurrency_limit < 0:
            raise ValueError("concurrency_limit must be non-negative or None")
        self.concurrency_limit = concurrency_limit
        self.request_bucket = TokenBucket(rpm, window_seconds)
        self.token_bucket = TokenBucket(tpm, window_seconds)
        self._active: Dict[int, Reservation] = {}
        self._next_reservation_id = 1

    @property
    def running(self) -> int:
        return len(self._active)

    @property
    def available_requests(self) -> float:
        return self.request_bucket.available

    @property
    def available_tokens(self) -> float:
        return self.token_bucket.available

    def refill(self, now: float) -> None:
        self.request_bucket.refill(now)
        self.token_bucket.refill(now)

    def concurrency_feasible(self) -> bool:
        return self.concurrency_limit is None or self.running < self.concurrency_limit

    def feasible(self, demand: ResourceDemand, now: float) -> bool:
        return (
            self.concurrency_feasible()
            and self.request_bucket.can_consume(demand.requests, now)
            and self.token_bucket.can_consume(demand.tokens, now)
        )

    def reserve(self, node_id: str, demand: ResourceDemand, now: float) -> Reservation:
        if not self.feasible(demand, now):
            raise ResourceAdmissionError(
                "resources are not currently feasible for node {0!r}".format(node_id)
            )
        # Feasibility was checked atomically before either bucket is changed.
        self.request_bucket.consume(demand.requests, now)
        self.token_bucket.consume(demand.tokens, now)
        reservation = Reservation(
            id=self._next_reservation_id,
            node_id=node_id,
            demand=demand,
            created_at=now,
        )
        self._next_reservation_id += 1
        self._active[reservation.id] = reservation
        return reservation

    def quota_delay(self, demand: ResourceDemand, now: float) -> float:
        """Return quota-only wait; concurrency is awakened by completions."""

        return max(
            self.request_bucket.time_until(demand.requests, now),
            self.token_bucket.time_until(demand.tokens, now),
        )

    def reconcile(
        self,
        reservation: Optional[Reservation],
        now: float,
        actual_tokens: Optional[float] = None,
    ) -> bool:
        if reservation is None or not reservation.active:
            return False
        stored = self._active.pop(reservation.id, None)
        if stored is None:
            reservation.active = False
            return False

        actual = reservation.demand.tokens if actual_tokens is None else float(actual_tokens)
        if actual < 0:
            raise ValueError("actual_tokens must be non-negative")
        if actual < reservation.demand.tokens:
            self.token_bucket.refund(reservation.demand.tokens - actual, now)
        elif actual > reservation.demand.tokens:
            self.token_bucket.charge(actual - reservation.demand.tokens, now)
        else:
            self.refill(now)
        reservation.active = False
        return True

    def snapshot(self, now: float) -> Dict[str, float]:
        self.refill(now)
        return {
            "running": float(self.running),
            "requests": self.available_requests,
            "tokens": self.available_tokens,
        }


@dataclass(frozen=True)
class CommitRecord:
    node_id: str
    result: Any
    attempt_id: Any
    generation: int
    committed_at: float


class ResultLedger:
    """In-memory compare-and-set ledger for logical node results."""

    def __init__(self) -> None:
        self._records: Dict[str, CommitRecord] = {}

    def commit_once(
        self,
        node_id: str,
        result: Any,
        attempt_id: Any = None,
        generation: int = 0,
        committed_at: float = 0.0,
    ) -> bool:
        if node_id in self._records:
            return False
        self._records[node_id] = CommitRecord(
            node_id=node_id,
            result=result,
            attempt_id=attempt_id,
            generation=generation,
            committed_at=committed_at,
        )
        return True

    def contains(self, node_id: str) -> bool:
        return node_id in self._records

    def get(self, node_id: str, default: Any = None) -> Any:
        record = self._records.get(node_id)
        return default if record is None else record.result

    def record(self, node_id: str) -> Optional[CommitRecord]:
        return self._records.get(node_id)

    @property
    def records(self) -> Mapping[str, CommitRecord]:
        return dict(self._records)

    def __contains__(self, node_id: object) -> bool:
        return node_id in self._records

    def __getitem__(self, node_id: str) -> Any:
        return self._records[node_id].result

    def __len__(self) -> int:
        return len(self._records)


@dataclass(frozen=True)
class EventRecord:
    time: float
    sequence: int
    kind: EventType
    node_id: Optional[str]
    details: Mapping[str, Any]


@dataclass(order=True)
class _ScheduledEvent:
    time: float
    sequence: int
    kind: EventType = field(compare=False)
    payload: Dict[str, Any] = field(compare=False, default_factory=dict)


def _coerce_outcome(value: Any) -> AttemptOutcome:
    if isinstance(value, AttemptOutcome):
        return value
    if isinstance(value, (Failure, FailureKind, BaseException)):
        return AttemptOutcome.failure(value)
    if isinstance(value, dict):
        data = dict(value)
        if "failure" in data and "error" not in data:
            data["error"] = data.pop("failure")
        if data.get("error") is not None:
            data["error"] = coerce_failure(data["error"])
        return AttemptOutcome(**data)
    return AttemptOutcome.success(value)


class DynamicDAGScheduler:
    """Deterministic virtual-time scheduler for an incrementally built DAG."""

    def __init__(
        self,
        *,
        concurrency_limit: Optional[int] = None,
        concurrency: Optional[int] = None,
        rpm: Optional[float] = None,
        tpm: Optional[float] = None,
        quota_window_seconds: float = 60.0,
        resource_manager: Optional[ResourceManager] = None,
    ) -> None:
        if concurrency is not None:
            if concurrency_limit is not None and concurrency_limit != concurrency:
                raise ValueError("conflicting concurrency limits")
            concurrency_limit = concurrency
        if resource_manager is not None and any(
            value is not None for value in (concurrency_limit, rpm, tpm)
        ):
            raise ValueError(
                "pass either resource_manager or concurrency/RPM/TPM parameters"
            )

        self.nodes: Dict[str, Node] = {}
        self.ledger = ResultLedger()
        self.resource_manager = resource_manager or ResourceManager(
            concurrency_limit=concurrency_limit,
            rpm=rpm,
            tpm=tpm,
            window_seconds=quota_window_seconds,
        )
        self.resources = self.resource_manager
        self.current_time = 0.0
        self.event_log: List[EventRecord] = []
        self.rejected_results: List[EventRecord] = []

        self._scheduled: List[_ScheduledEvent] = []
        self._ready_heap: List[Tuple[int, str]] = []
        self._schedule_sequence = 0
        self._log_sequence = 0
        self._admission_sequence = 0
        self._quota_wakeup_at: Optional[float] = None
        self._quota_wakeup_token = 0
        self._draining_admissions = False

    @property
    def now(self) -> float:
        return self.current_time

    def _next_schedule_sequence(self) -> int:
        self._schedule_sequence += 1
        return self._schedule_sequence

    def _next_log_sequence(self) -> int:
        self._log_sequence += 1
        return self._log_sequence

    def _record(
        self,
        kind: Union[EventType, str],
        node_id: Optional[str] = None,
        **details: Any,
    ) -> EventRecord:
        kind = _coerce_enum(EventType, kind, "event type")
        record = EventRecord(
            time=self.current_time,
            sequence=self._next_log_sequence(),
            kind=kind,
            node_id=node_id,
            details=dict(details),
        )
        self.event_log.append(record)
        if kind is EventType.RESULT_REJECTED:
            self.rejected_results.append(record)
        return record

    def events_of(self, kind: Union[EventType, str]) -> List[EventRecord]:
        kind = _coerce_enum(EventType, kind, "event type")
        return [event for event in self.event_log if event.kind is kind]

    def get_node(self, node_id: Union[str, Node]) -> Node:
        if isinstance(node_id, Node):
            node_id = node_id.id
        try:
            return self.nodes[str(node_id)]
        except KeyError:
            raise UnknownNodeError(str(node_id))

    node = get_node

    def state(self, node_id: Union[str, Node]) -> NodeState:
        return self.get_node(node_id).state

    def result(self, node_id: Union[str, Node], default: Any = None) -> Any:
        node = self.get_node(node_id)
        return self.ledger.get(node.id, default)

    def add_node(
        self,
        node_id: str,
        *,
        trigger_rule: Union[TriggerRule, TriggerSpec, str, Tuple[Any, int]] = TriggerRule.ALL_SUCCESS,
        quorum: Optional[int] = None,
        estimated_tokens: float = 0.0,
        attempts: Optional[Sequence[Any]] = None,
        outcomes: Optional[Sequence[Any]] = None,
        duration: float = 0.0,
        result: Any = _UNSET,
        failure: Any = None,
        actual_tokens: Optional[float] = None,
        max_attempts: int = 1,
        retry_class: Union[RetryClass, str] = RetryClass.TRANSIENT_ONLY,
        effect_class: Union[EffectClass, str] = EffectClass.PURE,
        retry_backoff: float = 1.0,
        auto_complete: bool = True,
        on_success: Optional[
            Callable[["DynamicDAGScheduler", Node, Any], None]
        ] = None,
    ) -> Node:
        node_id = str(node_id)
        if not node_id:
            raise GraphMutationError("node id must be non-empty")
        if node_id in self.nodes:
            raise DuplicateNodeError("node already exists: {0!r}".format(node_id))
        if estimated_tokens < 0:
            raise ValueError("estimated_tokens must be non-negative")
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least one")
        if retry_backoff < 0:
            raise ValueError("retry_backoff must be non-negative")
        if attempts is not None and outcomes is not None:
            raise ValueError("use either attempts or outcomes, not both")

        trigger = _coerce_trigger(trigger_rule, quorum)
        supplied_outcomes = attempts if attempts is not None else outcomes
        if supplied_outcomes is None:
            if failure is not None:
                attempt_outcomes = (
                    AttemptOutcome.failure(
                        failure,
                        duration=duration,
                        actual_tokens=actual_tokens,
                    ),
                )
            else:
                if result is _UNSET:
                    result = node_id
                attempt_outcomes = (
                    AttemptOutcome.success(
                        result,
                        duration=duration,
                        actual_tokens=actual_tokens,
                    ),
                )
        else:
            attempt_outcomes = tuple(_coerce_outcome(item) for item in supplied_outcomes)
            if not attempt_outcomes:
                raise ValueError("attempts/outcomes cannot be empty")

        node = Node(
            id=node_id,
            trigger_rule=trigger.rule,
            quorum=trigger.quorum,
            estimated_tokens=float(estimated_tokens),
            outcomes=attempt_outcomes,
            max_attempts=max_attempts,
            retry_class=_coerce_enum(RetryClass, retry_class, "retry class"),
            effect_class=_coerce_enum(EffectClass, effect_class, "effect class"),
            retry_backoff=float(retry_backoff),
            auto_complete=bool(auto_complete),
            on_success=on_success,
        )
        self.nodes[node_id] = node
        self._record(
            EventType.ADD_NODE,
            node_id,
            trigger_rule=node.trigger_rule.value,
            quorum=node.quorum,
        )
        return node

    def _would_create_cycle(self, parent: Node, child: Node) -> bool:
        if parent is child:
            return True
        stack = [child]
        visited = set()
        while stack:
            current = stack.pop()
            if current.id in visited:
                continue
            visited.add(current.id)
            if current is parent:
                return True
            for edge in current.consumers:
                stack.append(edge.child)
        return False

    def _assert_acyclic(self) -> None:
        colors: Dict[str, int] = {}

        def visit(node: Node) -> None:
            color = colors.get(node.id, 0)
            if color == 1:
                raise CycleError("graph contains a directed cycle")
            if color == 2:
                return
            colors[node.id] = 1
            for edge in node.consumers:
                visit(edge.child)
            colors[node.id] = 2

        for graph_node in self.nodes.values():
            if colors.get(graph_node.id, 0) == 0:
                visit(graph_node)

    def _resolve_edge_from_terminal_parent(self, edge: Edge) -> None:
        if edge.status is not EdgeStatus.PENDING or not edge.parent.is_terminal:
            return
        edge.child.required_done += 1
        if edge.parent.state is NodeState.SUCCEEDED:
            edge.status = EdgeStatus.SUCCESS
            edge.child.required_satisfied += 1
        else:
            edge.status = EdgeStatus.DONE_UNSUCCESSFUL
            edge.child.required_impossible += 1

    def add_edge(
        self,
        parent_id: Union[str, Node],
        child_id: Union[str, Node],
    ) -> Edge:
        parent = self.get_node(parent_id)
        child = self.get_node(child_id)
        if child.sealed or child.state is not NodeState.DECLARED:
            raise LateEdgeError(
                "cannot add incoming edge to sealed/frozen node {0!r}".format(child.id)
            )
        if any(edge.child is child for edge in parent.consumers):
            raise DuplicateEdgeError(
                "edge already exists: {0!r} -> {1!r}".format(parent.id, child.id)
            )
        if self._would_create_cycle(parent, child):
            raise CycleError(
                "edge would create a cycle: {0!r} -> {1!r}".format(
                    parent.id, child.id
                )
            )

        edge = Edge(parent=parent, child=child)
        parent.consumers.append(edge)
        child.incoming.append(edge)
        child.required_total += 1
        self._resolve_edge_from_terminal_parent(edge)
        self._record(
            EventType.ADD_EDGE,
            child.id,
            parent_id=parent.id,
            child_id=child.id,
            edge_status=edge.status.value,
        )
        return edge

    def seal_node(self, node_id: Union[str, Node]) -> Node:
        node = self.get_node(node_id)
        if node.sealed:
            return node
        self._assert_acyclic()
        node.sealed = True
        if not node.is_terminal:
            node.state = NodeState.WAITING_DEPS
        self._record(EventType.SEAL_NODE, node.id)
        self._refresh_readiness(node)
        return node

    def seal_all(self) -> None:
        for node in list(self.nodes.values()):
            self.seal_node(node)

    def _trigger_status(self, node: Node) -> Tuple[bool, bool]:
        total = node.required_total
        successes = node.required_satisfied
        done = node.required_done
        remaining = total - done

        if node.trigger_rule is TriggerRule.ALL_SUCCESS:
            return successes == total, node.required_impossible > 0
        if node.trigger_rule is TriggerRule.ALL_DONE:
            return done == total, False
        if node.trigger_rule is TriggerRule.ANY_SUCCESS:
            if total == 0:
                return True, False
            return successes >= 1, done == total and successes == 0
        if node.trigger_rule is TriggerRule.QUORUM:
            threshold = node.quorum or 0
            return successes >= threshold, successes + remaining < threshold
        raise InvalidTriggerError("unsupported trigger: {0!r}".format(node.trigger_rule))

    def _enqueue_for_admission(self, node: Node, preserve_order: bool = False) -> None:
        if node._queued_for_admission:
            return
        if not preserve_order or node._admission_order is None:
            self._admission_sequence += 1
            node._admission_order = self._admission_sequence
        node._queued_for_admission = True
        heapq.heappush(self._ready_heap, (node._admission_order, node.id))

    def _refresh_readiness(self, node: Node) -> None:
        if not node.sealed or node.is_terminal:
            return
        if node.state in {
            NodeState.RUNNING,
            NodeState.RETRY_WAIT,
            NodeState.CANCELLING,
        }:
            return

        satisfied, impossible = self._trigger_status(node)
        if impossible:
            failure = Failure(
                FailureKind.PERMANENT,
                "trigger {0} became impossible".format(node.trigger_rule.value),
            )
            self._fail_node_final(node, failure, dependency_failure=True)
            return
        if satisfied:
            if node.state not in {NodeState.READY_LOGICAL, NodeState.ADMISSION_WAIT}:
                node.state = NodeState.READY_LOGICAL
                self._record(EventType.NODE_READY, node.id)
                self._enqueue_for_admission(node)
            return
        node.state = NodeState.WAITING_DEPS

    def _propagate_terminal(self, parent: Node) -> None:
        for edge in list(parent.consumers):
            if edge.status is not EdgeStatus.PENDING:
                continue
            self._resolve_edge_from_terminal_parent(edge)
            self._record(
                EventType.DEPENDENCY_RESOLVED,
                edge.child.id,
                parent_id=parent.id,
                parent_state=parent.state.value,
                edge_status=edge.status.value,
            )
            self._refresh_readiness(edge.child)

    def _fail_node_final(
        self,
        node: Node,
        failure: Failure,
        *,
        dependency_failure: bool = False,
        needs_reconciliation: bool = False,
    ) -> None:
        if node.is_terminal:
            return
        node.state = NodeState.FAILED_FINAL
        node.completed_at = self.current_time
        node.last_failure = failure
        node.needs_reconciliation = needs_reconciliation
        self._record(
            EventType.NODE_FAILED,
            node.id,
            failure_kind=failure.kind.value,
            message=failure.message,
            dependency_failure=dependency_failure,
            needs_reconciliation=needs_reconciliation,
        )
        self._propagate_terminal(node)

    def _demand_for(self, node: Node) -> ResourceDemand:
        return ResourceDemand(requests=1.0, tokens=node.estimated_tokens)

    def _schedule(
        self,
        kind: Union[EventType, str],
        when: float,
        payload: Optional[Mapping[str, Any]] = None,
    ) -> int:
        if when + _EPSILON < self.current_time:
            raise ValueError("cannot schedule an event in the past")
        kind = _coerce_enum(EventType, kind, "event type")
        sequence = self._next_schedule_sequence()
        heapq.heappush(
            self._scheduled,
            _ScheduledEvent(
                time=float(when),
                sequence=sequence,
                kind=kind,
                payload=dict(payload or {}),
            ),
        )
        return sequence

    def schedule_event(
        self,
        kind: Union[EventType, str],
        *,
        at: Optional[float] = None,
        delay: Optional[float] = None,
        payload: Optional[Mapping[str, Any]] = None,
        **details: Any,
    ) -> int:
        if at is not None and delay is not None:
            raise ValueError("use either at or delay, not both")
        when = self.current_time if at is None and delay is None else at
        if delay is not None:
            if delay < 0:
                raise ValueError("delay must be non-negative")
            when = self.current_time + delay
        assert when is not None
        event_payload = dict(payload or {})
        event_payload.update(details)
        return self._schedule(kind, float(when), event_payload)

    def schedule_callback(
        self,
        callback: Callable[["DynamicDAGScheduler"], None],
        *,
        at: Optional[float] = None,
        delay: Optional[float] = None,
    ) -> int:
        return self.schedule_event(
            EventType.CALLBACK,
            at=at,
            delay=delay,
            callback=callback,
        )

    def schedule_cancel(
        self,
        node_id: Union[str, Node],
        *,
        at: Optional[float] = None,
        delay: Optional[float] = None,
    ) -> int:
        node = self.get_node(node_id)
        return self.schedule_event(
            EventType.CANCEL_NODE,
            at=at,
            delay=delay,
            node_id=node.id,
        )

    def apply_event(
        self,
        kind: Union[EventType, str],
        payload: Optional[Mapping[str, Any]] = None,
        **details: Any,
    ) -> Any:
        kind = _coerce_enum(EventType, kind, "event type")
        values = dict(payload or {})
        values.update(details)

        if kind is EventType.ADD_NODE:
            node_id = values.pop("node_id", values.pop("id", None))
            if node_id is None:
                raise GraphMutationError("ADD_NODE requires node_id")
            return self.add_node(node_id, **values)
        if kind is EventType.ADD_EDGE:
            parent_id = values.pop("parent_id", values.pop("parent", None))
            child_id = values.pop("child_id", values.pop("child", None))
            if parent_id is None or child_id is None:
                raise GraphMutationError("ADD_EDGE requires parent_id and child_id")
            if values:
                raise GraphMutationError(
                    "unexpected ADD_EDGE fields: {0}".format(sorted(values))
                )
            return self.add_edge(parent_id, child_id)
        if kind is EventType.SEAL_NODE:
            node_id = values.pop("node_id", values.pop("id", None))
            if node_id is None or values:
                raise GraphMutationError("SEAL_NODE requires only node_id")
            return self.seal_node(node_id)
        if kind is EventType.CANCEL_NODE:
            node_id = values.pop("node_id", values.pop("id", None))
            if node_id is None or values:
                raise GraphMutationError("CANCEL_NODE requires only node_id")
            return self.cancel_node(node_id)
        raise SchedulerError("event is not a public graph/control event: {0}".format(kind.value))

    emit = apply_event
    handle_event = apply_event

    def _dispatch(self, node: Node) -> None:
        demand = self._demand_for(node)
        reservation = self.resource_manager.reserve(node.id, demand, self.current_time)
        node._queued_for_admission = False
        node._admission_order = None
        node.state = NodeState.RUNNING
        node.attempt += 1
        node.attempt_generation += 1
        generation = node.attempt_generation
        node._reservations[generation] = reservation
        node.attempt_start_times.append(self.current_time)
        self._record(
            EventType.ATTEMPT_STARTED,
            node.id,
            attempt=node.attempt,
            generation=generation,
            reserved_tokens=demand.tokens,
        )

        if not node.auto_complete:
            return
        outcome = node.outcome_for_attempt(node.attempt)
        payload = {
            "node_id": node.id,
            "generation": generation,
            "attempt": node.attempt,
            "actual_tokens": outcome.actual_tokens,
        }
        if outcome.error is None:
            payload["result"] = outcome.result
            kind = EventType.ATTEMPT_SUCCEEDED
        else:
            payload["failure"] = outcome.error
            kind = EventType.ATTEMPT_FAILED
        self._schedule(kind, self.current_time + outcome.duration, payload)

    def _invalidate_quota_wakeup(self) -> None:
        self._quota_wakeup_token += 1
        self._quota_wakeup_at = None

    def _schedule_quota_wakeup(self, blocked: Iterable[Node]) -> None:
        delays = []
        for node in blocked:
            delay = self.resource_manager.quota_delay(
                self._demand_for(node), self.current_time
            )
            if math.isfinite(delay) and delay > _EPSILON:
                delays.append(delay)
        if not delays:
            return
        target = self.current_time + min(delays)
        if (
            self._quota_wakeup_at is not None
            and self._quota_wakeup_at <= target + _EPSILON
        ):
            return
        self._quota_wakeup_token += 1
        token = self._quota_wakeup_token
        self._quota_wakeup_at = target
        self._schedule(EventType.QUOTA_WAKE, target, {"token": token})

    def _drain_admissions(self) -> None:
        if self._draining_admissions:
            return
        self._draining_admissions = True
        try:
            candidates: List[Tuple[int, str]] = []
            while self._ready_heap:
                candidates.append(heapq.heappop(self._ready_heap))

            blocked: List[Node] = []
            for order, node_id in candidates:
                node = self.nodes.get(node_id)
                if node is None:
                    continue
                node._queued_for_admission = False
                if node.state not in {
                    NodeState.READY_LOGICAL,
                    NodeState.ADMISSION_WAIT,
                }:
                    continue
                demand = self._demand_for(node)
                if self.resource_manager.feasible(demand, self.current_time):
                    self._dispatch(node)
                else:
                    if node.state is not NodeState.ADMISSION_WAIT:
                        node.state = NodeState.ADMISSION_WAIT
                        self._record(
                            EventType.ADMISSION_WAIT,
                            node.id,
                            concurrency_available=self.resource_manager.concurrency_feasible(),
                            quota_delay=self.resource_manager.quota_delay(
                                demand, self.current_time
                            ),
                        )
                    node._admission_order = order
                    blocked.append(node)

            for node in blocked:
                self._enqueue_for_admission(node, preserve_order=True)

            if blocked:
                self._schedule_quota_wakeup(blocked)
            else:
                self._invalidate_quota_wakeup()
        finally:
            self._draining_admissions = False

    def _reservation_for_generation(
        self, node: Node, generation: int
    ) -> Optional[Reservation]:
        return node._reservations.get(generation)

    def _reconcile_generation(
        self,
        node: Node,
        generation: int,
        actual_tokens: Optional[float],
    ) -> None:
        reservation = node._reservations.pop(generation, None)
        self.resource_manager.reconcile(
            reservation,
            self.current_time,
            actual_tokens=actual_tokens,
        )

    def _reject_result(self, node: Node, reason: str, generation: int) -> bool:
        if reason == "duplicate_commit":
            node.duplicate_results_rejected += 1
        else:
            node.late_results_rejected += 1
        self._record(
            EventType.RESULT_REJECTED,
            node.id,
            reason=reason,
            generation=generation,
            current_generation=node.attempt_generation,
            state=node.state.value,
        )
        return False

    def deliver_success(
        self,
        node_id: Union[str, Node],
        result: Any,
        *,
        generation: Optional[int] = None,
        attempt: Optional[int] = None,
        actual_tokens: Optional[float] = None,
        _drain: bool = True,
    ) -> bool:
        node = self.get_node(node_id)
        if generation is None:
            generation = node.attempt_generation
        if self.ledger.contains(node.id):
            return self._reject_result(node, "duplicate_commit", generation)
        if generation != node.attempt_generation:
            return self._reject_result(node, "stale_generation", generation)
        if node.state is not NodeState.RUNNING:
            return self._reject_result(node, "not_running", generation)

        self._reconcile_generation(node, generation, actual_tokens)
        attempt_id = node.attempt if attempt is None else attempt
        if not self.ledger.commit_once(
            node.id,
            result,
            attempt_id=attempt_id,
            generation=generation,
            committed_at=self.current_time,
        ):
            return self._reject_result(node, "duplicate_commit", generation)

        node.state = NodeState.SUCCEEDED
        node.result = result
        node.completed_at = self.current_time
        self._record(
            EventType.ATTEMPT_SUCCEEDED,
            node.id,
            attempt=attempt_id,
            generation=generation,
        )
        self._record(
            EventType.RESULT_COMMITTED,
            node.id,
            attempt=attempt_id,
            generation=generation,
            result=result,
        )

        if node.on_success is not None:
            node.on_success(self, node, result)
        self._propagate_terminal(node)
        if _drain:
            self._drain_admissions()
        return True

    complete_attempt = deliver_success
    commit_result = deliver_success

    def _retry_delay(self, node: Node, failure: Failure) -> float:
        if failure.retry_after is not None:
            return failure.retry_after
        exponent = max(0, node.attempt - 1)
        return node.retry_backoff * (2**exponent)

    def deliver_failure(
        self,
        node_id: Union[str, Node],
        failure: Any,
        *,
        generation: Optional[int] = None,
        attempt: Optional[int] = None,
        actual_tokens: Optional[float] = None,
        _drain: bool = True,
    ) -> bool:
        node = self.get_node(node_id)
        failure = coerce_failure(failure)
        if generation is None:
            generation = node.attempt_generation
        if self.ledger.contains(node.id):
            return self._reject_result(node, "duplicate_commit", generation)
        if generation != node.attempt_generation:
            return self._reject_result(node, "stale_generation", generation)
        if node.state is not NodeState.RUNNING:
            return self._reject_result(node, "not_running", generation)

        self._reconcile_generation(node, generation, actual_tokens)
        attempt_id = node.attempt if attempt is None else attempt
        node.last_failure = failure
        self._record(
            EventType.ATTEMPT_FAILED,
            node.id,
            attempt=attempt_id,
            generation=generation,
            failure_kind=failure.kind.value,
            message=failure.message,
        )

        disposition = classify_retry(
            failure,
            retry_class=node.retry_class,
            effect_class=node.effect_class,
        )
        if disposition is RetryDisposition.RETRY and node.attempt < node.max_attempts:
            delay = self._retry_delay(node, failure)
            node.state = NodeState.RETRY_WAIT
            self._schedule(
                EventType.RETRY_READY,
                self.current_time + delay,
                {"node_id": node.id, "generation": generation},
            )
            self._record(
                EventType.RETRY_SCHEDULED,
                node.id,
                delay=delay,
                next_attempt=node.attempt + 1,
                generation=generation,
            )
        else:
            self._fail_node_final(
                node,
                failure,
                needs_reconciliation=(disposition is RetryDisposition.RECONCILE),
            )
        if _drain:
            self._drain_admissions()
        return True

    fail_attempt = deliver_failure

    def cancel_node(self, node_id: Union[str, Node]) -> bool:
        node = self.get_node(node_id)
        if node.is_terminal:
            return False
        old_generation = node.attempt_generation
        node.state = NodeState.CANCELLING
        node.attempt_generation += 1
        node.sealed = True
        self._record(
            EventType.CANCEL_NODE,
            node.id,
            invalidated_generation=old_generation,
            new_generation=node.attempt_generation,
        )

        # A cancellation reconciles conservatively: release concurrency but do
        # not refund the reserved model tokens because actual remote usage may
        # be unknown.
        self._reconcile_generation(node, old_generation, actual_tokens=None)
        node.state = NodeState.CANCELLED
        node.completed_at = self.current_time
        node._queued_for_admission = False
        self._record(
            EventType.NODE_CANCELLED,
            node.id,
            generation=node.attempt_generation,
        )
        self._propagate_terminal(node)
        self._drain_admissions()
        return True

    def cancel_all(self) -> None:
        for node in list(self.nodes.values()):
            if not node.is_terminal:
                self.cancel_node(node)

    def _handle_scheduled_event(self, event: _ScheduledEvent) -> None:
        payload = dict(event.payload)
        if event.kind in {
            EventType.ADD_NODE,
            EventType.ADD_EDGE,
            EventType.SEAL_NODE,
            EventType.CANCEL_NODE,
        }:
            self.apply_event(event.kind, payload)
            return
        if event.kind is EventType.ATTEMPT_SUCCEEDED:
            self.deliver_success(
                payload.pop("node_id"),
                payload.pop("result", None),
                generation=payload.pop("generation", None),
                attempt=payload.pop("attempt", None),
                actual_tokens=payload.pop("actual_tokens", None),
                _drain=False,
            )
            return
        if event.kind is EventType.ATTEMPT_FAILED:
            self.deliver_failure(
                payload.pop("node_id"),
                payload.pop("failure"),
                generation=payload.pop("generation", None),
                attempt=payload.pop("attempt", None),
                actual_tokens=payload.pop("actual_tokens", None),
                _drain=False,
            )
            return
        if event.kind is EventType.RETRY_READY:
            node = self.get_node(payload["node_id"])
            generation = payload["generation"]
            if (
                node.state is NodeState.RETRY_WAIT
                and node.attempt_generation == generation
            ):
                node.state = NodeState.READY_LOGICAL
                self._record(
                    EventType.RETRY_READY,
                    node.id,
                    generation=generation,
                )
                self._enqueue_for_admission(node)
            return
        if event.kind is EventType.QUOTA_WAKE:
            token = payload["token"]
            if token == self._quota_wakeup_token:
                self._quota_wakeup_at = None
                self._record(EventType.QUOTA_WAKE)
            return
        if event.kind is EventType.CALLBACK:
            callback = payload["callback"]
            callback(self)
            return
        raise SchedulerError("unsupported scheduled event: {0}".format(event.kind.value))

    def _advance_time(self, target: float) -> None:
        if target + _EPSILON < self.current_time:
            raise ValueError("virtual time cannot move backwards")
        self.current_time = float(target)
        self.resource_manager.refill(self.current_time)

    def step(self) -> bool:
        """Dispatch current candidates and process one scheduled event."""

        self._drain_admissions()
        if not self._scheduled:
            return False
        event = heapq.heappop(self._scheduled)
        self._advance_time(event.time)
        self._handle_scheduled_event(event)
        self._drain_admissions()
        return True

    run_next = step

    def run(
        self,
        until: Optional[float] = None,
        *,
        max_events: int = 100000,
    ) -> int:
        """Run until no event can make progress, or until virtual ``until``.

        ADMISSION_WAIT nodes whose single demand exceeds a finite bucket remain
        blocked with no timer, which is intentional: no amount of refill can
        make an over-capacity request feasible.
        """

        if until is not None and until + _EPSILON < self.current_time:
            raise ValueError("until cannot be before current virtual time")
        if max_events < 1:
            raise ValueError("max_events must be positive")

        processed = 0
        while True:
            self._drain_admissions()
            if not self._scheduled:
                break
            if until is not None and self._scheduled[0].time > until + _EPSILON:
                self._advance_time(until)
                break
            if processed >= max_events:
                raise RuntimeError("maximum scheduled event count exceeded")
            event = heapq.heappop(self._scheduled)
            self._advance_time(event.time)
            self._handle_scheduled_event(event)
            processed += 1

        if until is not None and self.current_time < until - _EPSILON:
            self._advance_time(until)
            self._drain_admissions()
        return processed

    run_until_idle = run

    @property
    def all_terminal(self) -> bool:
        return bool(self.nodes) and all(node.is_terminal for node in self.nodes.values())

    @property
    def unfinished_nodes(self) -> Tuple[str, ...]:
        return tuple(node.id for node in self.nodes.values() if not node.is_terminal)

    @property
    def blocked_nodes(self) -> Tuple[str, ...]:
        return tuple(
            node.id
            for node in self.nodes.values()
            if node.state is NodeState.ADMISSION_WAIT
        )

    @property
    def start_order(self) -> Tuple[str, ...]:
        return tuple(
            event.node_id
            for event in self.event_log
            if event.kind is EventType.ATTEMPT_STARTED and event.node_id is not None
        )


# Friendly aliases for callers/tests that prefer a shorter simulator name.
Scheduler = DynamicDAGScheduler
DeterministicDAGScheduler = DynamicDAGScheduler
SchedulerSimulator = DynamicDAGScheduler


__all__ = [
    "AttemptOutcome",
    "CommitRecord",
    "CycleError",
    "DeterministicDAGScheduler",
    "DuplicateEdgeError",
    "DuplicateNodeError",
    "DynamicDAGScheduler",
    "Edge",
    "EdgeStatus",
    "EffectClass",
    "EventRecord",
    "EventType",
    "Failure",
    "FailureKind",
    "GraphMutationError",
    "InvalidTriggerError",
    "LateEdgeError",
    "Node",
    "NodeState",
    "Reservation",
    "ResourceAdmissionError",
    "ResourceDemand",
    "ResourceManager",
    "ResultLedger",
    "RetryClass",
    "RetryDisposition",
    "Scheduler",
    "SchedulerError",
    "SchedulerSimulator",
    "TERMINAL_STATES",
    "TokenBucket",
    "TriggerRule",
    "TriggerSpec",
    "UnknownNodeError",
    "classify_retry",
    "coerce_failure",
]
