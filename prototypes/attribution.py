#!/usr/bin/env python3
"""Zero-dependency PVF attribution for a time-unfolded execution trace.

The prototype implements the ``PVF`` algorithm described in
``research/reports/01_CREDIT_ASSIGNMENT_AND_METRICS.md``.  It is intentionally
observational: the returned credit is a provenance/verification proxy, not a
causal leave-one-out estimate.

Canonical input shape (a few documented aliases are accepted by the parser)::

    {
      "schema": "wea.pvf.trace/v1",
      "trace_id": "example",
      "cost_basis": "tokens",
      "default_self_weight": 1.0,
      "low_credit_threshold": 0.0,
      "occurrences": [
        {
          "id": "implement#1",
          "predecessors": ["plan#1"],
          "output_artifact_ids": ["patch"],
          "cost": {
            "input_tokens": 100,
            "output_tokens": 50,
            "wall_time_ms": 400,
            "critical_path_time_ms": 350,
            "dollars": 0.01
          }
        }
      ],
      "occurrence_edges": [
        {"source": "plan#1", "target": "implement#1"}
      ],
      "artifacts": [
        {
          "id": "patch",
          "producer": "implement#1",
          "coverage_weight": 1.0,
          "self_weight": 1.0
        }
      ],
      "relations": [
        {
          "source": "plan",
          "target": "patch",
          "relation": "derive",
          "weight": 0.9
        },
        {"source": "SELF", "target": "patch", "weight": 1.0}
      ],
      "terminal_anchors": [
        {"artifact_id": "patch", "utility": 1.0}
      ]
    }

``SELF`` is a reserved pseudo-source.  A ``SELF -> artifact`` relation supplies
that artifact's denominator-only self weight; it never propagates credit to a
node.  An artifact may also use ``producer: \"SELF\"`` for a tracked public or
external source.  Runtime loops and retries must already be unfolded into
separate occurrence IDs.  Both occurrence and artifact cycles are rejected.

CLI::

    python prototypes/attribution.py examples/sample_trace.json --pretty
    cat trace.json | python prototypes/attribution.py -
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple, Union

SELF = "SELF"
OUTPUT_SCHEMA = "wea.pvf.metrics/v1"

RELATION_DEFAULT_WEIGHTS: Dict[str, float] = {
    "read": 0.6,
    "use": 0.9,
    "quote": 0.9,
    "derive": 0.9,
    "validate": 1.0,
    "overwrite": 1.0,
    "side_effect": 1.0,
    "self": 1.0,
}

# A mere read is deliberately excluded: the report distinguishes an input being
# present/read from it being used in a downstream derivation.
MEANINGFUL_CONSUMER_RELATIONS: Set[str] = {
    "use",
    "quote",
    "derive",
    "validate",
    "overwrite",
    "side_effect",
}

COST_DIMENSIONS: Tuple[str, ...] = (
    "tokens",
    "dollars",
    "wall_time_ms",
    "critical_path_time_ms",
)

_NO_DEFAULT = object()
_MISSING = object()


class TraceValidationError(ValueError):
    """Raised when a trace cannot be safely interpreted as an unfolded DAG."""


@dataclass(frozen=True)
class Cost:
    tokens: float = 0.0
    dollars: float = 0.0
    wall_time_ms: float = 0.0
    critical_path_time_ms: float = 0.0

    def as_dict(self) -> Dict[str, float]:
        return {
            "tokens": _clean_number(self.tokens),
            "dollars": _clean_number(self.dollars),
            "wall_time_ms": _clean_number(self.wall_time_ms),
            "critical_path_time_ms": _clean_number(self.critical_path_time_ms),
        }

    def value(self, dimension: str) -> float:
        return float(getattr(self, dimension))


@dataclass(frozen=True)
class Occurrence:
    occurrence_id: str
    role: Optional[str]
    predecessors: Tuple[str, ...]
    input_artifact_ids: Tuple[str, ...]
    output_artifact_ids: Tuple[str, ...]
    cost: Cost
    order: int


@dataclass(frozen=True)
class Artifact:
    artifact_id: str
    producer: Optional[str]
    coverage_weight: float
    self_weight: Optional[float]
    order: int


@dataclass(frozen=True)
class Relation:
    source: str
    target: str
    relation: str
    weight: float
    order: int


@dataclass(frozen=True)
class ParsedTrace:
    trace_id: Optional[str]
    occurrences: Dict[str, Occurrence]
    artifacts: Dict[str, Artifact]
    relations: Tuple[Relation, ...]
    terminal_anchors: Dict[str, float]
    occurrence_edges: Tuple[Tuple[str, str], ...]
    occurrence_topological_order: Tuple[str, ...]
    artifact_topological_order: Tuple[str, ...]
    default_self_weight: float
    low_credit_threshold: float
    cost_basis: str


def _first(mapping: Mapping[str, Any], names: Sequence[str], default: Any = _NO_DEFAULT) -> Any:
    for name in names:
        if name in mapping:
            return mapping[name]
    if default is _NO_DEFAULT:
        raise KeyError(names[0])
    return default


def _as_mapping(value: Any, context: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise TraceValidationError("{} must be a JSON object".format(context))
    return value


def _as_list(value: Any, context: str) -> List[Any]:
    if not isinstance(value, list):
        raise TraceValidationError("{} must be a JSON array".format(context))
    return value


def _identifier(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TraceValidationError("{} must be a non-empty string".format(context))
    return value.strip()


def _number(
    value: Any,
    context: str,
    *,
    nonnegative: bool = False,
    minimum: Optional[float] = None,
    maximum: Optional[float] = None,
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TraceValidationError("{} must be a finite number".format(context))
    result = float(value)
    if not math.isfinite(result):
        raise TraceValidationError("{} must be a finite number".format(context))
    if nonnegative and result < 0.0:
        raise TraceValidationError("{} must be non-negative".format(context))
    if minimum is not None and result < minimum:
        raise TraceValidationError("{} must be >= {}".format(context, minimum))
    if maximum is not None and result > maximum:
        raise TraceValidationError("{} must be <= {}".format(context, maximum))
    return result


def _optional_id_list(value: Any, context: str) -> Tuple[str, ...]:
    if value is None:
        return ()
    values = _as_list(value, context)
    result: List[str] = []
    seen: Set[str] = set()
    for index, item in enumerate(values):
        if isinstance(item, Mapping):
            item = _first(item, ("artifact_id", "atom_id", "id"), default=None)
        item_id = _identifier(item, "{}[{}]".format(context, index))
        if item_id in seen:
            raise TraceValidationError("{} contains duplicate id {!r}".format(context, item_id))
        seen.add(item_id)
        result.append(item_id)
    return tuple(result)


def _parse_cost(value: Any, context: str) -> Cost:
    if value is None:
        return Cost()
    raw = _as_mapping(value, context)

    if "tokens" in raw:
        tokens = _number(raw["tokens"], context + ".tokens", nonnegative=True)
    else:
        input_tokens = _number(
            _first(raw, ("input_tokens",), default=0.0),
            context + ".input_tokens",
            nonnegative=True,
        )
        output_tokens = _number(
            _first(raw, ("output_tokens",), default=0.0),
            context + ".output_tokens",
            nonnegative=True,
        )
        tokens = input_tokens + output_tokens

    dollars = _number(
        _first(raw, ("dollars", "monetary_cost", "usd"), default=0.0),
        context + ".dollars",
        nonnegative=True,
    )
    wall_time_ms = _number(
        _first(raw, ("wall_time_ms", "wallclock_ms", "duration_ms"), default=0.0),
        context + ".wall_time_ms",
        nonnegative=True,
    )
    critical_path_time_ms = _number(
        _first(
            raw,
            ("critical_path_time_ms", "critical_path_ms"),
            default=0.0,
        ),
        context + ".critical_path_time_ms",
        nonnegative=True,
    )
    if critical_path_time_ms > wall_time_ms and wall_time_ms > 0.0:
        raise TraceValidationError(
            "{}.critical_path_time_ms cannot exceed wall_time_ms".format(context)
        )
    return Cost(tokens, dollars, wall_time_ms, critical_path_time_ms)


def _normalize_producer(value: Any, context: str) -> Optional[str]:
    if value is None:
        return None
    producer = _identifier(value, context)
    if producer.upper() == SELF:
        return SELF
    return producer


def _artifact_from_record(
    raw_value: Any,
    *,
    context: str,
    order: int,
    producer_hint: Optional[str] = None,
) -> Artifact:
    if isinstance(raw_value, str):
        artifact_id = _identifier(raw_value, context)
        return Artifact(artifact_id, producer_hint, 1.0, None, order)

    raw = _as_mapping(raw_value, context)
    artifact_id = _identifier(
        _first(raw, ("id", "artifact_id", "atom_id"), default=None),
        context + ".id",
    )
    producer_value = _first(
        raw,
        ("producer", "producer_occurrence_id", "producer_node_id", "producer_attempt_id"),
        default=producer_hint,
    )
    producer = _normalize_producer(producer_value, context + ".producer")
    if producer_hint is not None and producer is not None and producer != producer_hint:
        raise TraceValidationError(
            "{} declares producer {!r}, expected {!r}".format(context, producer, producer_hint)
        )
    if producer is None:
        producer = producer_hint

    coverage_weight = _number(
        _first(raw, ("coverage_weight", "atom_weight"), default=1.0),
        context + ".coverage_weight",
        nonnegative=True,
    )
    self_weight_value = _first(raw, ("self_weight",), default=None)
    self_weight = None
    if self_weight_value is not None:
        self_weight = _number(
            self_weight_value,
            context + ".self_weight",
            nonnegative=True,
        )
    return Artifact(artifact_id, producer, coverage_weight, self_weight, order)


def _merge_artifact(existing: Artifact, new: Artifact, context: str) -> Artifact:
    if existing.producer is not None and new.producer is not None and existing.producer != new.producer:
        raise TraceValidationError(
            "artifact {!r} has conflicting producers {!r} and {!r} ({})".format(
                existing.artifact_id, existing.producer, new.producer, context
            )
        )
    producer = existing.producer if existing.producer is not None else new.producer

    # Top-level artifact metadata wins over a node's reference-only declaration.
    coverage_weight = existing.coverage_weight
    self_weight = existing.self_weight if existing.self_weight is not None else new.self_weight
    return replace(existing, producer=producer, coverage_weight=coverage_weight, self_weight=self_weight)


def _parse_relation_weight(raw: Mapping[str, Any], relation: str, context: str) -> float:
    if "weight" in raw:
        return _number(raw["weight"], context + ".weight")

    weight = RELATION_DEFAULT_WEIGHTS[relation]
    for keys, label in (
        (("q_match", "match_quality"), "q_match"),
        (("q_receipt", "receipt_quality"), "q_receipt"),
        (("necessity",), "necessity"),
        (("confidence",), "confidence"),
    ):
        factor = _first(raw, keys, default=1.0)
        weight *= _number(
            factor,
            context + "." + label,
            minimum=0.0,
            maximum=1.0,
        )
    valence = _number(
        _first(raw, ("valence",), default=1.0),
        context + ".valence",
        minimum=-1.0,
        maximum=1.0,
    )
    return weight * valence


def _topological_order(
    vertices: Sequence[str],
    edges: Iterable[Tuple[str, str]],
    *,
    label: str,
) -> Tuple[str, ...]:
    index = {vertex: position for position, vertex in enumerate(vertices)}
    adjacency: Dict[str, Set[str]] = {vertex: set() for vertex in vertices}
    indegree: Dict[str, int] = {vertex: 0 for vertex in vertices}

    for source, target in edges:
        if source not in index or target not in index:
            raise TraceValidationError(
                "{} edge {!r} -> {!r} references an unknown vertex".format(label, source, target)
            )
        if target not in adjacency[source]:
            adjacency[source].add(target)
            indegree[target] += 1

    ready: List[Tuple[int, str]] = [
        (index[vertex], vertex) for vertex in vertices if indegree[vertex] == 0
    ]
    heapq.heapify(ready)
    result: List[str] = []
    while ready:
        _, vertex = heapq.heappop(ready)
        result.append(vertex)
        for successor in sorted(adjacency[vertex], key=index.__getitem__):
            indegree[successor] -= 1
            if indegree[successor] == 0:
                heapq.heappush(ready, (index[successor], successor))

    if len(result) != len(vertices):
        cyclic = [vertex for vertex in vertices if indegree[vertex] > 0]
        raise TraceValidationError(
            "{} contains a cycle involving {}; loops/retries must be time-unfolded "
            "into distinct occurrence/artifact IDs before attribution".format(
                label, ", ".join(repr(item) for item in cyclic)
            )
        )
    return tuple(result)


def parse_trace(raw_trace: Union[ParsedTrace, Mapping[str, Any]]) -> ParsedTrace:
    """Validate and parse a JSON-like trace into an immutable representation.

    The occurrence DAG is formed from explicit predecessor/edge declarations,
    input artifact bindings, and cross-occurrence artifact relations.  This
    catches a relation that contradicts the declared control order as a cycle.
    """

    if isinstance(raw_trace, ParsedTrace):
        return raw_trace
    trace = _as_mapping(raw_trace, "trace")

    trace_id_value = _first(trace, ("trace_id", "run_id"), default=None)
    trace_id = None
    if trace_id_value is not None:
        trace_id = _identifier(trace_id_value, "trace.trace_id")

    default_self_weight = _number(
        _first(trace, ("default_self_weight",), default=1.0),
        "trace.default_self_weight",
        nonnegative=True,
    )
    low_credit_threshold = _number(
        _first(trace, ("low_credit_threshold",), default=0.0),
        "trace.low_credit_threshold",
    )
    cost_basis = _identifier(
        _first(trace, ("cost_basis", "cost_metric"), default="tokens"),
        "trace.cost_basis",
    )
    if cost_basis not in COST_DIMENSIONS:
        raise TraceValidationError(
            "trace.cost_basis must be one of {}".format(", ".join(COST_DIMENSIONS))
        )

    occurrence_values = _first(trace, ("occurrences", "nodes"), default=[])
    occurrence_raw_list = _as_list(occurrence_values, "trace.occurrences")
    occurrences: Dict[str, Occurrence] = {}
    occurrence_records: Dict[str, Mapping[str, Any]] = {}
    inline_outputs: List[Tuple[str, Any, str]] = []

    for order, raw_value in enumerate(occurrence_raw_list):
        context = "trace.occurrences[{}]".format(order)
        raw = _as_mapping(raw_value, context)
        occurrence_id = _identifier(
            _first(
                raw,
                ("id", "occurrence_id", "attempt_id", "node_id"),
                default=None,
            ),
            context + ".id",
        )
        if occurrence_id == SELF:
            raise TraceValidationError("SELF is reserved and cannot be an occurrence id")
        if occurrence_id in occurrences:
            raise TraceValidationError("duplicate occurrence id {!r}".format(occurrence_id))

        predecessor_values = _first(raw, ("predecessors", "depends_on"), default=[])
        predecessors = _optional_id_list(predecessor_values, context + ".predecessors")
        input_values = _first(raw, ("input_artifact_ids", "inputs"), default=[])
        input_artifact_ids = _optional_id_list(input_values, context + ".input_artifact_ids")

        output_values = _first(
            raw,
            ("output_artifact_ids", "output_atoms", "outputs"),
            default=[],
        )
        output_list = _as_list(output_values, context + ".output_artifact_ids")
        output_ids: List[str] = []
        output_seen: Set[str] = set()
        for output_index, output_value in enumerate(output_list):
            output_context = "{}.output_artifact_ids[{}]".format(context, output_index)
            if isinstance(output_value, Mapping):
                output_id_value = _first(
                    output_value, ("id", "artifact_id", "atom_id"), default=None
                )
            else:
                output_id_value = output_value
            output_id = _identifier(output_id_value, output_context)
            if output_id in output_seen:
                raise TraceValidationError(
                    "{} contains duplicate artifact {!r}".format(
                        context + ".output_artifact_ids", output_id
                    )
                )
            output_seen.add(output_id)
            output_ids.append(output_id)
            inline_outputs.append((occurrence_id, output_value, output_context))

        role_value = _first(raw, ("role", "logical_node_id"), default=None)
        role = None if role_value is None else _identifier(role_value, context + ".role")
        occurrence = Occurrence(
            occurrence_id=occurrence_id,
            role=role,
            predecessors=predecessors,
            input_artifact_ids=input_artifact_ids,
            output_artifact_ids=tuple(output_ids),
            cost=_parse_cost(_first(raw, ("cost",), default=None), context + ".cost"),
            order=order,
        )
        occurrences[occurrence_id] = occurrence
        occurrence_records[occurrence_id] = raw

    for occurrence in occurrences.values():
        for predecessor in occurrence.predecessors:
            if predecessor not in occurrences:
                raise TraceValidationError(
                    "occurrence {!r} references unknown predecessor {!r}".format(
                        occurrence.occurrence_id, predecessor
                    )
                )
            if predecessor == occurrence.occurrence_id:
                raise TraceValidationError(
                    "occurrence {!r} depends on itself; loops must be time-unfolded".format(
                        occurrence.occurrence_id
                    )
                )

    artifact_values = _first(trace, ("artifacts", "atoms"), default=[])
    artifact_raw_list = _as_list(artifact_values, "trace.artifacts")
    artifacts: Dict[str, Artifact] = {}
    artifact_terminal_values: List[Tuple[str, Any, str]] = []
    next_artifact_order = 0

    for raw_index, raw_value in enumerate(artifact_raw_list):
        context = "trace.artifacts[{}]".format(raw_index)
        artifact = _artifact_from_record(
            raw_value, context=context, order=next_artifact_order
        )
        next_artifact_order += 1
        if artifact.artifact_id == SELF:
            raise TraceValidationError("SELF is reserved and cannot be an artifact id")
        if artifact.artifact_id in artifacts:
            raise TraceValidationError("duplicate artifact id {!r}".format(artifact.artifact_id))
        artifacts[artifact.artifact_id] = artifact
        if isinstance(raw_value, Mapping):
            terminal_value = _first(
                raw_value,
                ("terminal_utility", "utility_anchor", "anchor"),
                default=_MISSING,
            )
            if terminal_value is not _MISSING:
                artifact_terminal_values.append(
                    (artifact.artifact_id, terminal_value, context)
                )

    for producer_id, raw_value, context in inline_outputs:
        inline_artifact = _artifact_from_record(
            raw_value,
            context=context,
            order=next_artifact_order,
            producer_hint=producer_id,
        )
        if inline_artifact.artifact_id == SELF:
            raise TraceValidationError("SELF is reserved and cannot be an artifact id")
        if inline_artifact.artifact_id in artifacts:
            artifacts[inline_artifact.artifact_id] = _merge_artifact(
                artifacts[inline_artifact.artifact_id], inline_artifact, context
            )
        else:
            artifacts[inline_artifact.artifact_id] = inline_artifact
            next_artifact_order += 1
        if isinstance(raw_value, Mapping):
            terminal_value = _first(
                raw_value,
                ("terminal_utility", "utility_anchor", "anchor"),
                default=_MISSING,
            )
            if terminal_value is not _MISSING:
                artifact_terminal_values.append(
                    (inline_artifact.artifact_id, terminal_value, context)
                )

    for artifact in list(artifacts.values()):
        if artifact.producer is not None and artifact.producer != SELF:
            if artifact.producer not in occurrences:
                raise TraceValidationError(
                    "artifact {!r} references unknown producer occurrence {!r}".format(
                        artifact.artifact_id, artifact.producer
                    )
                )

    for occurrence in occurrences.values():
        for artifact_id in occurrence.output_artifact_ids:
            if artifact_id not in artifacts:
                raise TraceValidationError(
                    "occurrence {!r} declares unknown output artifact {!r}".format(
                        occurrence.occurrence_id, artifact_id
                    )
                )
            producer = artifacts[artifact_id].producer
            if producer != occurrence.occurrence_id:
                raise TraceValidationError(
                    "occurrence {!r} declares artifact {!r}, whose producer is {!r}".format(
                        occurrence.occurrence_id, artifact_id, producer
                    )
                )
        for artifact_id in occurrence.input_artifact_ids:
            if artifact_id not in artifacts:
                raise TraceValidationError(
                    "occurrence {!r} references unknown input artifact {!r}".format(
                        occurrence.occurrence_id, artifact_id
                    )
                )

    relation_values = _first(trace, ("relations", "artifact_relations"), default=[])
    relation_raw_list = list(_as_list(relation_values, "trace.relations"))
    relation_contexts = [
        "trace.relations[{}]".format(index) for index in range(len(relation_raw_list))
    ]

    # Node-local consumption events are accepted when they identify a target
    # artifact.  With exactly one output, the target can be inferred.
    for occurrence_id, raw in occurrence_records.items():
        events = _first(raw, ("consumption_events",), default=[])
        event_list = _as_list(
            events,
            "occurrence {!r}.consumption_events".format(occurrence_id),
        )
        for event_index, event_value in enumerate(event_list):
            event_context = "occurrence {!r}.consumption_events[{}]".format(
                occurrence_id, event_index
            )
            event = dict(_as_mapping(event_value, event_context))
            if not any(
                key in event for key in ("target", "target_artifact_id", "to")
            ):
                outputs = occurrences[occurrence_id].output_artifact_ids
                if len(outputs) != 1:
                    raise TraceValidationError(
                        "{} must name target_artifact_id when the consumer has {} outputs".format(
                            event_context, len(outputs)
                        )
                    )
                event["target_artifact_id"] = outputs[0]
            relation_raw_list.append(event)
            relation_contexts.append(event_context)

    relations: List[Relation] = []
    for order, (raw_value, context) in enumerate(zip(relation_raw_list, relation_contexts)):
        raw = _as_mapping(raw_value, context)
        source = _identifier(
            _first(raw, ("source", "source_artifact_id", "from"), default=None),
            context + ".source",
        )
        if source.upper() == SELF:
            source = SELF
        target = _identifier(
            _first(raw, ("target", "target_artifact_id", "to"), default=None),
            context + ".target",
        )
        relation_name = _identifier(
            _first(raw, ("relation", "type", "mode"), default="self" if source == SELF else "derive"),
            context + ".relation",
        ).lower()
        if source == SELF:
            relation_name = "self"
        if relation_name not in RELATION_DEFAULT_WEIGHTS:
            raise TraceValidationError(
                "{} has unsupported relation {!r}; expected one of {}".format(
                    context, relation_name, ", ".join(sorted(RELATION_DEFAULT_WEIGHTS))
                )
            )
        weight = _parse_relation_weight(raw, relation_name, context)
        if source == SELF and weight < 0.0:
            raise TraceValidationError("{} SELF weight must be non-negative".format(context))
        if source != SELF and source not in artifacts:
            raise TraceValidationError(
                "{} references unknown source artifact {!r}".format(context, source)
            )
        if target not in artifacts:
            raise TraceValidationError(
                "{} references unknown target artifact {!r}".format(context, target)
            )
        if source == target:
            raise TraceValidationError(
                "{} is a self-loop on artifact {!r}; loops must be time-unfolded".format(
                    context, target
                )
            )
        relations.append(Relation(source, target, relation_name, weight, order))

    terminal_anchors: Dict[str, float] = {}

    def add_terminal(artifact_id: str, value: Any, context: str) -> None:
        if artifact_id not in artifacts:
            raise TraceValidationError(
                "{} references unknown terminal artifact {!r}".format(context, artifact_id)
            )
        if artifact_id in terminal_anchors:
            raise TraceValidationError(
                "duplicate terminal anchor for artifact {!r}".format(artifact_id)
            )
        terminal_anchors[artifact_id] = _number(value, context + ".utility")

    terminal_values = _first(trace, ("terminal_anchors", "terminals"), default=[])
    if isinstance(terminal_values, Mapping):
        for artifact_id_value, utility_value in terminal_values.items():
            artifact_id = _identifier(artifact_id_value, "trace.terminal_anchors key")
            if isinstance(utility_value, Mapping):
                utility_value = _first(
                    utility_value, ("utility", "anchor", "value"), default=None
                )
            add_terminal(
                artifact_id,
                utility_value,
                "trace.terminal_anchors[{!r}]".format(artifact_id),
            )
    else:
        for index, raw_value in enumerate(
            _as_list(terminal_values, "trace.terminal_anchors")
        ):
            context = "trace.terminal_anchors[{}]".format(index)
            if isinstance(raw_value, str):
                add_terminal(_identifier(raw_value, context), 1.0, context)
                continue
            raw = _as_mapping(raw_value, context)
            artifact_id = _identifier(
                _first(raw, ("artifact_id", "atom_id", "id"), default=None),
                context + ".artifact_id",
            )
            utility = _first(raw, ("utility", "anchor", "value"), default=None)
            add_terminal(artifact_id, utility, context)

    for artifact_id, terminal_value, context in artifact_terminal_values:
        add_terminal(artifact_id, terminal_value, context)

    occurrence_edge_values = _first(trace, ("occurrence_edges",), default=[])
    occurrence_edges_raw = _as_list(occurrence_edge_values, "trace.occurrence_edges")
    occurrence_edge_set: Set[Tuple[str, str]] = set()

    for occurrence in occurrences.values():
        for predecessor in occurrence.predecessors:
            occurrence_edge_set.add((predecessor, occurrence.occurrence_id))

    for index, raw_value in enumerate(occurrence_edges_raw):
        context = "trace.occurrence_edges[{}]".format(index)
        if isinstance(raw_value, list) and len(raw_value) == 2:
            source_value, target_value = raw_value
        else:
            raw = _as_mapping(raw_value, context)
            source_value = _first(raw, ("source", "from"), default=None)
            target_value = _first(raw, ("target", "to"), default=None)
        source = _identifier(source_value, context + ".source")
        target = _identifier(target_value, context + ".target")
        if source not in occurrences or target not in occurrences:
            raise TraceValidationError(
                "{} references unknown occurrence edge {!r} -> {!r}".format(
                    context, source, target
                )
            )
        occurrence_edge_set.add((source, target))

    # Input bindings impose occurrence order even though they are intentionally
    # not treated as proof of artifact-level contribution.
    for occurrence in occurrences.values():
        for artifact_id in occurrence.input_artifact_ids:
            producer = artifacts[artifact_id].producer
            if producer not in (None, SELF, occurrence.occurrence_id):
                occurrence_edge_set.add((producer, occurrence.occurrence_id))

    artifact_edges: List[Tuple[str, str]] = []
    for relation in relations:
        if relation.source == SELF or relation.weight == 0.0:
            continue
        artifact_edges.append((relation.source, relation.target))
        source_producer = artifacts[relation.source].producer
        target_producer = artifacts[relation.target].producer
        if (
            source_producer not in (None, SELF)
            and target_producer not in (None, SELF)
            and source_producer != target_producer
        ):
            occurrence_edge_set.add((source_producer, target_producer))

    occurrence_ids = list(occurrences)
    occurrence_topological_order = _topological_order(
        occurrence_ids,
        occurrence_edge_set,
        label="occurrence DAG",
    )
    artifact_ids = list(artifacts)
    artifact_topological_order = _topological_order(
        artifact_ids,
        artifact_edges,
        label="artifact relation DAG",
    )

    edge_order = {item: index for index, item in enumerate(occurrence_edge_set)}
    ordered_occurrence_edges = tuple(
        sorted(
            occurrence_edge_set,
            key=lambda item: (
                occurrences[item[0]].order,
                occurrences[item[1]].order,
                edge_order[item],
            ),
        )
    )

    return ParsedTrace(
        trace_id=trace_id,
        occurrences=occurrences,
        artifacts=artifacts,
        relations=tuple(relations),
        terminal_anchors=terminal_anchors,
        occurrence_edges=ordered_occurrence_edges,
        occurrence_topological_order=occurrence_topological_order,
        artifact_topological_order=artifact_topological_order,
        default_self_weight=default_self_weight,
        low_credit_threshold=low_credit_threshold,
        cost_basis=cost_basis,
    )


def validate_trace(raw_trace: Union[ParsedTrace, Mapping[str, Any]]) -> ParsedTrace:
    """Public validation alias; returns the parsed trace on success."""

    return parse_trace(raw_trace)


def _ratio(numerator: float, denominator: float) -> float:
    if denominator <= 0.0:
        return 0.0
    return _clean_number(numerator / denominator)


def _clean_number(value: float) -> float:
    value = float(value)
    if abs(value) < 1e-15:
        return 0.0
    return value


def attribute_trace(raw_trace: Union[ParsedTrace, Mapping[str, Any]]) -> Dict[str, Any]:
    """Compute PVF artifact/node credit and the report's trace-only metrics."""

    trace = parse_trace(raw_trace)
    incoming: Dict[str, List[Relation]] = {
        artifact_id: [] for artifact_id in trace.artifacts
    }
    outgoing: Dict[str, List[Relation]] = {
        artifact_id: [] for artifact_id in trace.artifacts
    }
    explicit_self: Dict[str, List[Relation]] = {
        artifact_id: [] for artifact_id in trace.artifacts
    }
    for relation in trace.relations:
        if relation.source == SELF:
            explicit_self[relation.target].append(relation)
        else:
            incoming[relation.target].append(relation)
            outgoing[relation.source].append(relation)

    self_weights: Dict[str, float] = {}
    for artifact_id, artifact in trace.artifacts.items():
        if explicit_self[artifact_id]:
            self_weights[artifact_id] = sum(
                relation.weight for relation in explicit_self[artifact_id]
            )
        elif artifact.self_weight is not None:
            self_weights[artifact_id] = artifact.self_weight
        else:
            self_weights[artifact_id] = trace.default_self_weight

    artifact_credit: Dict[str, float] = {
        artifact_id: trace.terminal_anchors.get(artifact_id, 0.0)
        for artifact_id in trace.artifacts
    }
    self_retained_credit: Dict[str, float] = {
        artifact_id: 0.0 for artifact_id in trace.artifacts
    }

    for target in reversed(trace.artifact_topological_order):
        active_incoming = [
            relation for relation in incoming[target] if relation.weight != 0.0
        ]
        denominator = self_weights[target] + sum(
            abs(relation.weight) for relation in active_incoming
        )
        if denominator <= 0.0:
            continue
        target_credit = artifact_credit[target]
        self_retained_credit[target] = (
            target_credit * self_weights[target] / denominator
        )
        for relation in active_incoming:
            artifact_credit[relation.source] += (
                target_credit * relation.weight / denominator
            )

    for artifact_id in artifact_credit:
        artifact_credit[artifact_id] = _clean_number(artifact_credit[artifact_id])
        self_retained_credit[artifact_id] = _clean_number(
            self_retained_credit[artifact_id]
        )

    # Terminal reachability is provenance reachability, not merely a path in the
    # control DAG.  Zero-utility anchors still count as observed terminal paths.
    terminal_reachable_artifacts: Set[str] = set(trace.terminal_anchors)
    stack = list(trace.terminal_anchors)
    while stack:
        target = stack.pop()
        for relation in incoming[target]:
            if relation.weight == 0.0:
                continue
            source = relation.source
            if source not in terminal_reachable_artifacts:
                terminal_reachable_artifacts.add(source)
                stack.append(source)

    outputs_by_occurrence: Dict[str, List[str]] = {
        occurrence_id: [] for occurrence_id in trace.occurrences
    }
    for artifact_id, artifact in trace.artifacts.items():
        if artifact.producer in outputs_by_occurrence:
            outputs_by_occurrence[artifact.producer].append(artifact_id)

    node_credit: Dict[str, float] = {}
    node_terminal_reachable: Dict[str, bool] = {}
    for occurrence_id in trace.occurrence_topological_order:
        outputs = outputs_by_occurrence[occurrence_id]
        node_credit[occurrence_id] = _clean_number(
            sum(artifact_credit[artifact_id] for artifact_id in outputs)
        )
        node_terminal_reachable[occurrence_id] = any(
            artifact_id in terminal_reachable_artifacts for artifact_id in outputs
        )

    produced_artifacts = [
        artifact
        for artifact in trace.artifacts.values()
        if artifact.producer in trace.occurrences
    ]
    consumer_total_weight = sum(
        artifact.coverage_weight for artifact in produced_artifacts
    )
    meaningfully_consumed: Set[str] = set()
    observed_consumed: Set[str] = set()
    for artifact in produced_artifacts:
        for relation in outgoing[artifact.artifact_id]:
            if relation.weight == 0.0:
                continue
            target_producer = trace.artifacts[relation.target].producer
            if target_producer == artifact.producer:
                continue
            observed_consumed.add(artifact.artifact_id)
            if relation.relation in MEANINGFUL_CONSUMER_RELATIONS:
                meaningfully_consumed.add(artifact.artifact_id)
    consumer_covered_weight = sum(
        trace.artifacts[artifact_id].coverage_weight
        for artifact_id in meaningfully_consumed
    )
    observed_consumer_covered_weight = sum(
        trace.artifacts[artifact_id].coverage_weight
        for artifact_id in observed_consumed
    )

    # A terminal atom is provenance-covered if it can be traced to a concrete
    # occurrence or an explicit SELF source.  Producer=None is allowed so the
    # metric can expose incomplete instrumentation instead of rejecting it.
    tracked_provenance: Set[str] = set()
    for artifact_id in trace.artifact_topological_order:
        artifact = trace.artifacts[artifact_id]
        tracked = artifact.producer == SELF or artifact.producer in trace.occurrences
        if not tracked and any(
            relation.weight > 0.0 for relation in explicit_self[artifact_id]
        ):
            tracked = True
        if not tracked:
            tracked = any(
                relation.weight != 0.0 and relation.source in tracked_provenance
                for relation in incoming[artifact_id]
            )
        if tracked:
            tracked_provenance.add(artifact_id)

    terminal_total_weight = sum(
        trace.artifacts[artifact_id].coverage_weight
        for artifact_id in trace.terminal_anchors
    )
    covered_terminal_ids = [
        artifact_id
        for artifact_id in trace.terminal_anchors
        if artifact_id in tracked_provenance
    ]
    terminal_covered_weight = sum(
        trace.artifacts[artifact_id].coverage_weight
        for artifact_id in covered_terminal_ids
    )
    uncovered_terminal_ids = [
        artifact_id
        for artifact_id in trace.terminal_anchors
        if artifact_id not in tracked_provenance
    ]

    dead_nodes = [
        occurrence_id
        for occurrence_id in trace.occurrence_topological_order
        if not node_terminal_reachable[occurrence_id]
    ]
    low_credit_nodes = [
        occurrence_id
        for occurrence_id in trace.occurrence_topological_order
        if node_credit[occurrence_id] <= trace.low_credit_threshold
    ]

    dead_cost_breakdown: Dict[str, Dict[str, float]] = {}
    for dimension in COST_DIMENSIONS:
        total = sum(
            occurrence.cost.value(dimension)
            for occurrence in trace.occurrences.values()
        )
        dead = sum(
            trace.occurrences[occurrence_id].cost.value(dimension)
            for occurrence_id in dead_nodes
        )
        dead_cost_breakdown[dimension] = {
            "dead": _clean_number(dead),
            "total": _clean_number(total),
            "rate": _ratio(dead, total),
        }

    basis_breakdown = dead_cost_breakdown[trace.cost_basis]
    critical_path_total = dead_cost_breakdown["critical_path_time_ms"]["total"]
    critical_path_waste = sum(
        trace.occurrences[occurrence_id].cost.critical_path_time_ms
        for occurrence_id in low_credit_nodes
    )

    node_details: Dict[str, Dict[str, Any]] = {}
    for occurrence_id in trace.occurrence_topological_order:
        occurrence = trace.occurrences[occurrence_id]
        credit = node_credit[occurrence_id]
        tokens = occurrence.cost.tokens
        critical_ms = occurrence.cost.critical_path_time_ms
        node_details[occurrence_id] = {
            "role": occurrence.role,
            "credit": credit,
            "terminal_reachable": node_terminal_reachable[occurrence_id],
            "dead": not node_terminal_reachable[occurrence_id],
            "low_credit": occurrence_id in low_credit_nodes,
            "output_artifact_ids": list(outputs_by_occurrence[occurrence_id]),
            "cost": occurrence.cost.as_dict(),
            "positive_credit_per_token": _ratio(max(credit, 0.0), tokens),
            "positive_credit_per_critical_path_ms": _ratio(
                max(credit, 0.0), critical_ms
            ),
        }

    artifact_details: Dict[str, Dict[str, Any]] = {}
    for artifact_id in trace.artifact_topological_order:
        artifact = trace.artifacts[artifact_id]
        artifact_details[artifact_id] = {
            "producer": artifact.producer,
            "credit": artifact_credit[artifact_id],
            "terminal_anchor": _clean_number(
                trace.terminal_anchors.get(artifact_id, 0.0)
            ),
            "terminal_reachable": artifact_id in terminal_reachable_artifacts,
            "provenance_tracked": artifact_id in tracked_provenance,
            "coverage_weight": _clean_number(artifact.coverage_weight),
            "self_weight": _clean_number(self_weights[artifact_id]),
            "self_retained_credit": self_retained_credit[artifact_id],
        }

    external_self_credit = sum(
        artifact_credit[artifact_id]
        for artifact_id, artifact in trace.artifacts.items()
        if artifact.producer == SELF
    )
    untracked_artifact_credit = sum(
        artifact_credit[artifact_id]
        for artifact_id, artifact in trace.artifacts.items()
        if artifact.producer is None
    )

    metrics: Dict[str, Any] = {
        "consumer_coverage": _ratio(
            consumer_covered_weight, consumer_total_weight
        ),
        "consumer_coverage_weight": {
            "covered": _clean_number(consumer_covered_weight),
            "total": _clean_number(consumer_total_weight),
        },
        "observed_consumer_coverage": _ratio(
            observed_consumer_covered_weight, consumer_total_weight
        ),
        "provenance_coverage": _ratio(
            terminal_covered_weight, terminal_total_weight
        ),
        "provenance_coverage_weight": {
            "covered": _clean_number(terminal_covered_weight),
            "total": _clean_number(terminal_total_weight),
        },
        "uncovered_terminal_artifact_ids": uncovered_terminal_ids,
        "terminal_anchor_count": len(trace.terminal_anchors),
        "terminal_reachable_node_count": sum(node_terminal_reachable.values()),
        "terminal_reachability_rate": _ratio(
            float(sum(node_terminal_reachable.values())),
            float(len(trace.occurrences)),
        ),
        "dead_nodes": dead_nodes,
        "dead_cost_basis": trace.cost_basis,
        "dead_cost": basis_breakdown["dead"],
        "dead_cost_rate": basis_breakdown["rate"],
        "dead_cost_breakdown": dead_cost_breakdown,
        "low_credit_threshold": _clean_number(trace.low_credit_threshold),
        "low_credit_nodes": low_credit_nodes,
        "critical_path_waste_nodes": [
            occurrence_id
            for occurrence_id in low_credit_nodes
            if trace.occurrences[occurrence_id].cost.critical_path_time_ms > 0.0
        ],
        "critical_path_waste_ms": _clean_number(critical_path_waste),
        "critical_path_waste_rate": _ratio(
            critical_path_waste, critical_path_total
        ),
    }

    return {
        "schema": OUTPUT_SCHEMA,
        "trace_id": trace.trace_id,
        "method": "PVF",
        "method_note": "single-trace contribution proxy; not causal LOO credit",
        "occurrence_topological_order": list(trace.occurrence_topological_order),
        "artifact_topological_order": list(trace.artifact_topological_order),
        "node_credit": node_credit,
        "artifact_credit": {
            artifact_id: artifact_credit[artifact_id]
            for artifact_id in trace.artifact_topological_order
        },
        "external_credit": {
            "SELF": _clean_number(external_self_credit),
            "untracked": _clean_number(untracked_artifact_credit),
        },
        "nodes": node_details,
        "artifacts": artifact_details,
        "metrics": metrics,
    }


def pvf(raw_trace: Union[ParsedTrace, Mapping[str, Any]]) -> Dict[str, Any]:
    """Short public name for :func:`attribute_trace`."""

    return attribute_trace(raw_trace)


def compute_attribution(
    raw_trace: Union[ParsedTrace, Mapping[str, Any]]
) -> Dict[str, Any]:
    """Compatibility-friendly public name for :func:`attribute_trace`."""

    return attribute_trace(raw_trace)


def compute_pvf(raw_trace: Union[ParsedTrace, Mapping[str, Any]]) -> Dict[str, Any]:
    """Compatibility-friendly public name for :func:`attribute_trace`."""

    return attribute_trace(raw_trace)


def _load_json(path: str) -> Any:
    if path == "-":
        return json.load(sys.stdin)
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(result: Mapping[str, Any], path: str, pretty: bool) -> None:
    kwargs: Dict[str, Any] = {
        "ensure_ascii": False,
        "allow_nan": False,
        "sort_keys": True,
    }
    if pretty:
        kwargs["indent"] = 2
    else:
        kwargs["separators"] = (",", ":")

    if path == "-":
        json.dump(result, sys.stdout, **kwargs)
        sys.stdout.write("\n")
        return
    with Path(path).open("w", encoding="utf-8") as handle:
        json.dump(result, handle, **kwargs)
        handle.write("\n")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate a time-unfolded occurrence/artifact DAG and emit "
            "single-trace PVF attribution metrics as JSON."
        )
    )
    parser.add_argument("trace", help="input trace JSON path, or '-' for stdin")
    parser.add_argument(
        "-o",
        "--output",
        default="-",
        help="output metrics JSON path (default: stdout)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="pretty-print the output JSON",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    try:
        raw_trace = _load_json(args.trace)
        result = attribute_trace(raw_trace)
        _write_json(result, args.output, args.pretty)
    except (OSError, json.JSONDecodeError, TraceValidationError) as exc:
        print("attribution: error: {}".format(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
