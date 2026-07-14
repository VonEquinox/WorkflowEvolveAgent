/**
 * Minimal event-driven graph scheduler — TS port of the Phase 1 subset of
 * prototypes/scheduler.py (ALL_SUCCESS / ANY_SUCCESS triggers, SEAL semantics,
 * dependency failure propagation, bounded feedback loops by runtime unfolding).
 *
 * Semantics kept from the prototype:
 *  - a node only becomes READY after seal (no new incoming edges afterwards);
 *  - trigger ALL_SUCCESS: satisfied when all required parents SUCCEEDED,
 *    impossible as soon as one required parent is terminally unsuccessful;
 *  - trigger ANY_SUCCESS: satisfied on first success, impossible when all
 *    parents are done without a success;
 *  - impossible trigger → node FAILED (dependency failure) and propagates;
 *  - FEEDBACK edges do not count into readiness; they drive bounded re-runs:
 *    when the feedback source succeeds and its JSON output says "retry", the
 *    loop body is re-armed (attempt_no + 1) until maxIterations is exhausted.
 */

import { TERMINAL_STATES } from "./types.ts";
import type { BoundedLoop, GraphEdge, GraphNode, NodeState, WorkflowGraph } from "./types.ts";

type EdgeStatus = "PENDING" | "SUCCESS" | "DONE_UNSUCCESSFUL";

export interface SchedulerEvent {
	type:
		| "SEAL_NODE"
		| "NODE_READY"
		| "NODE_RUNNING"
		| "NODE_SUCCEEDED"
		| "NODE_FAILED"
		| "NODE_RETRY"
		| "NODE_SKIPPED"
		| "LOOP_ITERATION"
		| "LOOP_EXHAUSTED";
	nodeId?: string;
	loopId?: string;
	iteration?: number;
	detail?: string;
	at: string; // ISO timestamp
}

export interface NodeRuntime {
	state: NodeState;
	attemptNo: number;
	sealed: boolean;
	/** Why the node failed, when state === FAILED. */
	failure?: { code: string; message: string; dependencyFailure: boolean };
	plannedAt: string;
	readyAt?: string;
}

/** Decides whether a completed feedback-source node requests another loop pass. */
export type LoopRetryPredicate = (sourceNodeId: string, output: unknown) => boolean;

const now = () => new Date().toISOString();

export class GraphScheduler {
	readonly nodes = new Map<string, GraphNode>();
	readonly runtime = new Map<string, NodeRuntime>();
	readonly events: SchedulerEvent[] = [];

	private incoming = new Map<string, GraphEdge[]>();
	private outgoing = new Map<string, GraphEdge[]>();
	private edgeStatus = new Map<string, EdgeStatus>();
	private loops = new Map<string, BoundedLoop & { iteration: number }>();
	private loopRetry: LoopRetryPredicate;

	constructor(graph: WorkflowGraph, loopRetry?: LoopRetryPredicate) {
		this.loopRetry = loopRetry ?? defaultLoopRetry;
		for (const node of graph.nodes) {
			if (this.nodes.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
			this.nodes.set(node.id, node);
			this.runtime.set(node.id, { state: "DECLARED", attemptNo: 1, sealed: false, plannedAt: now() });
			this.incoming.set(node.id, []);
			this.outgoing.set(node.id, []);
		}
		for (const edge of graph.edges) {
			if (edge.kind === "FEEDBACK" && !edge.loopId) {
				throw new Error(`feedback edge ${edge.id} must name a bounded loop`);
			}
			if (edge.kind !== "FEEDBACK" && edge.loopId) {
				throw new Error(`only FEEDBACK edges may name a loop (edge ${edge.id})`);
			}
			this.edgeStatus.set(edge.id, "PENDING");
			if (edge.from !== "@input" && this.nodes.has(edge.from)) this.outgoing.get(edge.from)!.push(edge);
			if (edge.to !== "@output" && this.nodes.has(edge.to)) this.incoming.get(edge.to)!.push(edge);
		}
		for (const loop of graph.loops) {
			for (const nodeId of loop.bodyNodes) {
				if (!this.nodes.has(nodeId)) throw new Error(`loop ${loop.id} references unknown node ${nodeId}`);
			}
			if (loop.maxIterations < 1) throw new Error(`loop ${loop.id} must allow at least one iteration`);
			this.loops.set(loop.id, { ...loop, iteration: 1 });
		}
		this.assertAcyclicIgnoringFeedback(graph);
	}

	/** DAG check excluding FEEDBACK edges — mirrors validate_ir.py's rule. */
	private assertAcyclicIgnoringFeedback(graph: WorkflowGraph): void {
		const indegree = new Map<string, number>();
		const adj = new Map<string, string[]>();
		for (const n of graph.nodes) {
			indegree.set(n.id, 0);
			adj.set(n.id, []);
		}
		for (const e of graph.edges) {
			if (e.kind === "FEEDBACK" || e.from.startsWith("@") || e.to.startsWith("@")) continue;
			adj.get(e.from)!.push(e.to);
			indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
		}
		const ready = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
		let visited = 0;
		while (ready.length) {
			const cur = ready.pop()!;
			visited += 1;
			for (const next of adj.get(cur)!) {
				const d = indegree.get(next)! - 1;
				indegree.set(next, d);
				if (d === 0) ready.push(next);
			}
		}
		if (visited !== graph.nodes.length) throw new Error("graph contains an undeclared cycle (excluding FEEDBACK edges)");
	}

	private record(type: SchedulerEvent["type"], extra: Partial<SchedulerEvent> = {}): void {
		this.events.push({ type, at: now(), ...extra });
	}

	sealAll(): void {
		for (const [id, rt] of this.runtime) {
			if (rt.sealed) continue;
			rt.sealed = true;
			if (!TERMINAL_STATES.has(rt.state)) rt.state = "WAITING_DEPS";
			this.record("SEAL_NODE", { nodeId: id });
			this.refreshReadiness(id);
		}
	}

	/** Required (readiness-relevant) incoming edges: DATA + CONTROL, not FEEDBACK. */
	private requiredParents(nodeId: string): GraphEdge[] {
		return (this.incoming.get(nodeId) ?? []).filter((e) => e.kind !== "FEEDBACK" && e.from !== "@input");
	}

	private triggerStatus(nodeId: string): { satisfied: boolean; impossible: boolean } {
		const node = this.nodes.get(nodeId)!;
		const parents = this.requiredParents(nodeId);
		const total = parents.length;
		const successes = parents.filter((e) => this.edgeStatus.get(e.id) === "SUCCESS").length;
		const done = parents.filter((e) => this.edgeStatus.get(e.id) !== "PENDING").length;
		if (node.trigger === "ALL_SUCCESS") {
			return { satisfied: successes === total, impossible: done > successes };
		}
		// ANY_SUCCESS
		if (total === 0) return { satisfied: true, impossible: false };
		return { satisfied: successes >= 1, impossible: done === total && successes === 0 };
	}

	private refreshReadiness(nodeId: string): void {
		const rt = this.runtime.get(nodeId)!;
		if (!rt.sealed || TERMINAL_STATES.has(rt.state) || rt.state === "RUNNING") return;
		const { satisfied, impossible } = this.triggerStatus(nodeId);
		if (impossible) {
			this.failNode(nodeId, {
				code: "DEPENDENCY_FAILED",
				message: `trigger ${this.nodes.get(nodeId)!.trigger} became impossible`,
				dependencyFailure: true,
			});
			return;
		}
		if (satisfied && rt.state !== "READY") {
			rt.state = "READY";
			rt.readyAt = now();
			this.record("NODE_READY", { nodeId });
			return;
		}
		if (!satisfied) rt.state = "WAITING_DEPS";
	}

	readyNodes(): string[] {
		return [...this.runtime.entries()].filter(([, rt]) => rt.state === "READY").map(([id]) => id);
	}

	markRunning(nodeId: string): void {
		const rt = this.runtime.get(nodeId)!;
		if (rt.state !== "READY") throw new Error(`node ${nodeId} is not READY (state=${rt.state})`);
		rt.state = "RUNNING";
		this.record("NODE_RUNNING", { nodeId });
	}

	/** Report a finished attempt. `output` is the parsed node JSON (for loop predicates). */
	reportSuccess(nodeId: string, output: unknown): void {
		const rt = this.runtime.get(nodeId)!;
		rt.state = "SUCCEEDED";
		this.record("NODE_SUCCEEDED", { nodeId });
		this.resolveOutgoing(nodeId, "SUCCESS");
		this.handleFeedback(nodeId, output);
	}

	reportFailure(nodeId: string, code: string, message: string): void {
		this.failNode(nodeId, { code, message, dependencyFailure: false });
	}

	/**
	 * Bounded node-level retry (D14): a RUNNING node whose attempt failed
	 * retryably is re-armed WITHOUT resolving its outgoing edges — parents are
	 * still satisfied, so it goes straight back to READY with attempt_no + 1.
	 */
	retryNode(nodeId: string): void {
		const rt = this.runtime.get(nodeId)!;
		if (rt.state !== "RUNNING") throw new Error(`retryNode: ${nodeId} is not RUNNING (state=${rt.state})`);
		rt.attemptNo += 1;
		rt.state = "WAITING_DEPS";
		delete rt.failure;
		this.record("NODE_RETRY", { nodeId });
		this.refreshReadiness(nodeId);
	}

	private failNode(nodeId: string, failure: NonNullable<NodeRuntime["failure"]>): void {
		const rt = this.runtime.get(nodeId)!;
		if (TERMINAL_STATES.has(rt.state)) return;
		rt.state = "FAILED";
		rt.failure = failure;
		this.record("NODE_FAILED", { nodeId, detail: `${failure.code}: ${failure.message}` });
		this.resolveOutgoing(nodeId, "DONE_UNSUCCESSFUL");
	}

	private resolveOutgoing(nodeId: string, status: EdgeStatus): void {
		for (const edge of this.outgoing.get(nodeId) ?? []) {
			if (edge.kind === "FEEDBACK") continue; // feedback handled separately
			if (this.edgeStatus.get(edge.id) !== "PENDING") continue;
			this.edgeStatus.set(edge.id, status);
			if (edge.to !== "@output") this.refreshReadiness(edge.to);
		}
	}

	/** Bounded-loop engine: re-arm body nodes when the feedback source asks for another pass. */
	private handleFeedback(sourceNodeId: string, output: unknown): void {
		for (const edge of this.outgoing.get(sourceNodeId) ?? []) {
			if (edge.kind !== "FEEDBACK") continue;
			const loop = this.loops.get(edge.loopId!)!;
			if (!this.loopRetry(sourceNodeId, output)) continue; // verdict says done
			if (loop.iteration >= loop.maxIterations) {
				this.record("LOOP_EXHAUSTED", { loopId: loop.id, iteration: loop.iteration });
				continue;
			}
			loop.iteration += 1;
			this.record("LOOP_ITERATION", { loopId: loop.id, iteration: loop.iteration });
			// Re-arm every body node: new attempt, edges from body producers reset.
			for (const nodeId of loop.bodyNodes) {
				const rt = this.runtime.get(nodeId)!;
				rt.state = "WAITING_DEPS";
				rt.attemptNo += 1;
				delete rt.failure;
				for (const e of this.outgoing.get(nodeId) ?? []) {
					if (e.kind !== "FEEDBACK") this.edgeStatus.set(e.id, "PENDING");
				}
			}
			// Edges from non-body producers into the body stay SUCCESS (their
			// artifacts are still valid inputs for the next pass).
			for (const nodeId of loop.bodyNodes) this.refreshReadiness(nodeId);
		}
	}

	allTerminal(): boolean {
		return [...this.runtime.values()].every((rt) => TERMINAL_STATES.has(rt.state));
	}

	/** True when nothing is READY/RUNNING and not everything is terminal → wedged. */
	stalled(): boolean {
		const states = [...this.runtime.values()].map((rt) => rt.state);
		return (
			!this.allTerminal() &&
			!states.includes("READY") &&
			!states.includes("RUNNING")
		);
	}

	attemptNo(nodeId: string): number {
		return this.runtime.get(nodeId)!.attemptNo;
	}
}

/** Default loop predicate: retry while output JSON carries verdict:"fail" (or retry:true). */
export function defaultLoopRetry(_sourceNodeId: string, output: unknown): boolean {
	if (output == null || typeof output !== "object") return false;
	const o = output as Record<string, unknown>;
	if (o.verdict === "fail" || o.verdict === "retry") return true;
	if (o.retry === true) return true;
	return false;
}
