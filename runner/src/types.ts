/**
 * @wea/runner — shared types for the L1+L2 layer.
 *
 * Two trace surfaces are produced from one in-memory run record (see trace-export.ts):
 *   1. wea.trace/v1     — compliance trace, must pass tools/validate_ir.py
 *   2. wea.pvf.trace/v1 — PVF attribution input for prototypes/attribution.py
 *
 * The graph/scheduling vocabulary is a minimal TS port of prototypes/scheduler.py:
 * only the Phase 1 subset (ALL_SUCCESS / ANY_SUCCESS + bounded loop) is modeled.
 */

// ---- Graph / scheduling -----------------------------------------------------

/** Node lifecycle. Subset of scheduler.py NodeState relevant to Phase 1. */
export type NodeState =
	| "DECLARED"
	| "WAITING_DEPS"
	| "READY"
	| "RUNNING"
	| "SUCCEEDED"
	| "FAILED"
	| "CANCELLED"
	| "SKIPPED";

export const TERMINAL_STATES: ReadonlySet<NodeState> = new Set<NodeState>([
	"SUCCEEDED",
	"FAILED",
	"CANCELLED",
	"SKIPPED",
]);

/** Phase 1 trigger subset. QUORUM/ALL_DONE deferred (port later from scheduler.py). */
export type TriggerRule = "ALL_SUCCESS" | "ANY_SUCCESS";

/** Edge readiness contribution. Phase 1 uses DATA (implies success) + CONTROL. */
export type EdgeKind = "DATA" | "CONTROL" | "FEEDBACK";

export interface GraphEdge {
	id: string;
	from: string; // producer node id, or "@input"
	to: string; // consumer node id, or "@output"
	kind: EdgeKind;
	/** Set only for FEEDBACK edges; names the bounded loop this edge closes. */
	loopId?: string | null;
}

/** A bounded loop: body executes at most maxIterations times. */
export interface BoundedLoop {
	id: string;
	bodyNodes: string[];
	feedbackEdges: string[];
	maxIterations: number;
}

/** Node role → which pi tools + how it reports out. */
export type NodeKind = "planner" | "worker" | "verifier" | "aggregator";

/** A logical node in the workflow graph (template-instantiated). */
export interface GraphNode {
	id: string;
	kind: NodeKind;
	/** agents/*.md card id that supplies the system prompt + tool allowlist. */
	agentCard: string;
	trigger: TriggerRule;
	/** Task prompt template; ${artifact.<nodeId>} refs are resolved at spawn time. */
	promptTemplate: string;
	/**
	 * Deprecated for workers: live runs always use the user's default pi model.
	 * Field may still appear in historical templates; orchestrator strips it.
	 */
	model?: string;
	/**
	 * Proactive WEA master takeover point. When true (or agentCard is
	 * "master-handoff"), the orchestrator does NOT spawn a pi worker: it packs
	 * upstream context, calls the WEA control model to plan, then dispatches a
	 * code-edit graph with that plan injected as ${master_plan}.
	 */
	controlHandoff?: boolean;
	/** Per-node budget ceiling; runner aborts the session if exceeded. */
	budget?: NodeBudget;
}

export interface WorkflowGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
	loops: BoundedLoop[];
}

// ---- Budget -----------------------------------------------------------------

export interface NodeBudget {
	maxTokens?: number;
	maxMonetaryMicrounits?: number;
	maxWallTimeMs?: number;
}

export interface RunBudget {
	wallTimeMs: number;
	modelTokens: number;
	monetaryMicrounits: number;
}

// ---- Recorder captures (from pi events) -------------------------------------

/** One LLM call's usage, from a pi message_end event. */
export interface UsageSample {
	input: number;
	output: number;
	cachedInput: number;
	total: number;
	costMicrounits: number;
}

/** One tool_call, typed input preserved (path/pattern give the read/write set). */
export interface ToolCallSample {
	tool: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

/** One tool_result. pi carries NO content digest (FINDINGS U5) → we hash content ourselves. */
export interface ToolResultSample {
	tool: string;
	toolCallId: string;
	isError: boolean;
	/** sha256 of the concatenated text content the model actually saw. */
	contentDigest: string;
	details: unknown;
}

/** Everything one node attempt produced, captured in-memory by the recorder. */
export interface NodeRunRecord {
	nodeId: string;
	attemptNo: number;
	/**
	 * Graph phase counter: 0 for the initial graph, then +1 on each replan or
	 * master-handoff edit-graph start. Used so nodeId+attemptNo collisions across
	 * phases cannot flip run status or feed a later node a prior phase's output.
	 */
	graphGeneration: number;
	agentCard: string;
	kind: NodeKind;
	sessionId: string;
	systemPromptDigest: string;
	toolCalls: ToolCallSample[];
	toolResults: ToolResultSample[];
	usage: UsageSample[];
	finalText: string;
	/** Parsed JSON output contract (D14/D21), or null on parse failure. */
	output: NodeOutput | null;
	status: "success" | "failure" | "cancelled";
	error: { code: string; message: string; retryable: boolean } | null;
	plannedAt: string;
	readyAt: string;
	startedAt: string;
	endedAt: string;
	/** normalized, repo-relative read paths (see FINDINGS §3.1). */
	readSet: string[];
	writeSet: string[];
	/** wea.trace/v1 dependency observations assembled by the recorder. */
	observations: import("./recorder-ext.ts").DependencyObservation[];
	/** true → dependency manifest completeness degrades to "conservative" (D10). */
	usedBash: boolean;
	/** how many sensitive-path reads were redacted (D23/SEC-001). */
	redactions: number;
}

/** The JSON output contract every node must emit as its final assistant message. */
export interface NodeOutput {
	summary: string;
	/** Artifact references this node produced, keyed by logical port name. */
	produced?: Record<string, unknown>;
	/** Free-form structured conclusion; PVF anchors read from here. */
	[k: string]: unknown;
}
