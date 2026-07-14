/**
 * Template applier + structural gate (L4).
 *
 * A meta-agent emits a proposal; this module applies it to a runner template
 * WITHOUT an LLM and produces a new version. The meta-agent is TRUSTED: it may
 * propose any redesign — remove or add nodes, rewire edges, rewrite prompts,
 * swap models, restructure loops. There is no menu of "allowed" edits and no
 * list of forbidden targets. It may remove a verifier, collapse the whole graph,
 * whatever it judges best.
 *
 * The gate is NOT a safety review. It answers exactly one question: does the
 * resulting template EXECUTE? A graph that can't run isn't "dangerous", it's
 * just not a runnable proposal. So the gate checks structural validity only:
 * edges reference real endpoints, @input reaches @output, no cycle outside a
 * declared FEEDBACK loop, no orphaned node. Safety lives downstream, in the
 * champion gate: a proposal becomes a CHALLENGER and only replaces the current
 * template if it actually wins a paired comparison; if it loses, the system
 * rolls back to the prior version, which is never destroyed. Power comes from
 * winning the measurement, not from being permitted.
 */

import type { GraphEdge, NodeKind, WorkflowGraph } from "./types.ts";

export interface RunnerTemplateDoc {
	id: string;
	version: string;
	summary: string;
	graph: WorkflowGraph;
}

/** The open edit vocabulary. Any sequence, applied in order. */
export type TemplateEdit =
	| { op: "remove_node"; node: string }
	| {
			op: "add_node";
			node: string;
			kind: NodeKind;
			agentCard: string;
			trigger: "ALL_SUCCESS" | "ANY_SUCCESS";
			promptTemplate: string;
	  }
	| { op: "edit_prompt"; node: string; new_prompt: string }
	| { op: "set_model"; node: string; model: string }
	| { op: "add_edge"; id: string; from: string; to: string; kind: GraphEdge["kind"]; loopId?: string | null }
	| { op: "remove_edge"; id: string }
	| { op: "set_loop"; id: string; bodyNodes: string[]; feedbackEdges: string[]; maxIterations: number }
	| { op: "remove_loop"; id: string };

export interface Proposal {
	schema: "wea.proposal/v2";
	target_template: string;
	target_version: string;
	edits: TemplateEdit[];
	reasoning?: string;
	hypothesis?: string;
	expected_effect?: string;
}

export interface GateResult {
	ok: boolean;
	/** structural reasons the proposal does not produce a runnable template. */
	violations: string[];
}

// ---- structural executability (the ONLY thing the gate enforces) ------------

function structuralIssues(graph: WorkflowGraph): string[] {
	const issues: string[] = [];
	const ids = new Set(graph.nodes.map((n) => n.id));
	if (graph.nodes.length === 0) issues.push("template has no nodes");

	// duplicate ids
	if (ids.size !== graph.nodes.length) issues.push("duplicate node id");
	const edgeIds = new Set(graph.edges.map((e) => e.id));
	if (edgeIds.size !== graph.edges.length) issues.push("duplicate edge id");

	// edges must reference existing endpoints
	for (const e of graph.edges) {
		if (e.from !== "@input" && !ids.has(e.from)) issues.push(`edge ${e.id} from unknown node ${e.from}`);
		if (e.to !== "@output" && !ids.has(e.to)) issues.push(`edge ${e.id} to unknown node ${e.to}`);
		if (e.kind === "FEEDBACK" && !e.loopId) issues.push(`feedback edge ${e.id} must name a loop`);
	}
	// loops must cover live nodes/edges
	for (const loop of graph.loops) {
		for (const nid of loop.bodyNodes) if (!ids.has(nid)) issues.push(`loop ${loop.id} references unknown node ${nid}`);
		for (const eid of loop.feedbackEdges) if (!edgeIds.has(eid)) issues.push(`loop ${loop.id} references unknown edge ${eid}`);
		if (loop.maxIterations < 1) issues.push(`loop ${loop.id} must allow >=1 iteration`);
	}
	// @input must reach @output through the executable (non-FEEDBACK) subgraph
	if (!outputReachable(graph)) issues.push("@output is not reachable from @input");
	// executable graph must be acyclic outside declared FEEDBACK edges
	if (hasCycleIgnoringFeedback(graph)) issues.push("graph contains a cycle outside a FEEDBACK loop");
	// no orphaned node (a node the scheduler could never make ready)
	for (const n of graph.nodes) {
		const parents = graph.edges.filter((e) => e.to === n.id && e.kind !== "FEEDBACK");
		if (parents.length === 0) issues.push(`node ${n.id} has no incoming edge (orphaned)`);
	}
	return issues;
}

function outputReachable(graph: WorkflowGraph): boolean {
	const adj = new Map<string, string[]>();
	for (const e of graph.edges) {
		if (e.kind === "FEEDBACK") continue;
		if (!adj.has(e.from)) adj.set(e.from, []);
		adj.get(e.from)!.push(e.to);
	}
	const seen = new Set<string>();
	const stack = ["@input"];
	while (stack.length) {
		const cur = stack.pop()!;
		if (cur === "@output") return true;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const nx of adj.get(cur) ?? []) stack.push(nx);
	}
	return false;
}

function hasCycleIgnoringFeedback(graph: WorkflowGraph): boolean {
	const indeg = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const n of graph.nodes) {
		indeg.set(n.id, 0);
		adj.set(n.id, []);
	}
	for (const e of graph.edges) {
		if (e.kind === "FEEDBACK" || e.from.startsWith("@") || e.to.startsWith("@")) continue;
		// Dangling edges (endpoint not a live node) are reported separately by the
		// edge-endpoint check; ignore them here so cycle detection can't crash.
		if (!adj.has(e.from) || !indeg.has(e.to)) continue;
		adj.get(e.from)!.push(e.to);
		indeg.set(e.to, indeg.get(e.to)! + 1);
	}
	const ready = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
	let visited = 0;
	while (ready.length) {
		const cur = ready.pop()!;
		visited += 1;
		for (const nx of adj.get(cur)!) {
			indeg.set(nx, indeg.get(nx)! - 1);
			if (indeg.get(nx) === 0) ready.push(nx);
		}
	}
	return visited !== graph.nodes.length;
}

/**
 * Gate a proposal. Returns structural reasons it would not produce a runnable
 * template — nothing else. An empty list means "this will execute", not "this is
 * a good idea"; whether it is good is decided by the champion comparison.
 */
export function gateProposal(template: RunnerTemplateDoc, proposal: Proposal): GateResult {
	const violations: string[] = [];
	if (proposal.target_template !== template.id) {
		violations.push(`proposal targets ${proposal.target_template}, not ${template.id}`);
	}
	if (proposal.edits.length === 0) {
		violations.push("proposal has no edits");
	}
	if (violations.length === 0) {
		let next: WorkflowGraph;
		try {
			next = applyEditsToGraph(structuredClone(template.graph), proposal.edits);
		} catch (err) {
			return { ok: false, violations: [`edit could not be applied: ${(err as Error).message}`] };
		}
		violations.push(...structuralIssues(next));
	}
	return { ok: violations.length === 0, violations };
}

// ---- applier (pure graph mutation over the full vocabulary) -----------------

export function applyEditsToGraph(graph: WorkflowGraph, edits: TemplateEdit[]): WorkflowGraph {
	let nodes = graph.nodes.map((n) => ({ ...n }));
	let edges: GraphEdge[] = graph.edges.map((e) => ({ ...e }));
	let loops = graph.loops.map((l) => ({ ...l, bodyNodes: [...l.bodyNodes], feedbackEdges: [...l.feedbackEdges] }));

	for (const edit of edits) {
		switch (edit.op) {
			case "remove_node": {
				nodes = nodes.filter((n) => n.id !== edit.node);
				edges = edges.filter((e) => e.from !== edit.node && e.to !== edit.node);
				const live = new Set(edges.map((e) => e.id));
				loops = loops
					.map((l) => ({
						...l,
						bodyNodes: l.bodyNodes.filter((n) => n !== edit.node),
						feedbackEdges: l.feedbackEdges.filter((id) => live.has(id)),
					}))
					.filter((l) => l.bodyNodes.length > 0 && l.feedbackEdges.length > 0);
				break;
			}
			case "add_node": {
				if (nodes.some((n) => n.id === edit.node)) throw new Error(`add_node: id ${edit.node} already exists`);
				nodes.push({
					id: edit.node,
					kind: edit.kind,
					agentCard: edit.agentCard,
					trigger: edit.trigger,
					promptTemplate: edit.promptTemplate,
				});
				break;
			}
			case "edit_prompt": {
				const n = nodes.find((x) => x.id === edit.node);
				if (!n) throw new Error(`edit_prompt: unknown node ${edit.node}`);
				n.promptTemplate = edit.new_prompt;
				break;
			}
			case "set_model": {
				const n = nodes.find((x) => x.id === edit.node);
				if (!n) throw new Error(`set_model: unknown node ${edit.node}`);
				n.model = edit.model;
				break;
			}
			case "add_edge": {
				if (edges.some((e) => e.id === edit.id)) throw new Error(`add_edge: id ${edit.id} already exists`);
				edges.push({ id: edit.id, from: edit.from, to: edit.to, kind: edit.kind, loopId: edit.loopId ?? null });
				break;
			}
			case "remove_edge": {
				edges = edges.filter((e) => e.id !== edit.id);
				loops = loops.map((l) => ({ ...l, feedbackEdges: l.feedbackEdges.filter((id) => id !== edit.id) }));
				break;
			}
			case "set_loop": {
				const existing = loops.find((l) => l.id === edit.id);
				const spec = {
					id: edit.id,
					bodyNodes: edit.bodyNodes,
					feedbackEdges: edit.feedbackEdges,
					maxIterations: edit.maxIterations,
				};
				if (existing) Object.assign(existing, spec);
				else loops.push(spec);
				break;
			}
			case "remove_loop": {
				loops = loops.filter((l) => l.id !== edit.id);
				break;
			}
		}
	}
	return { nodes, edges, loops };
}

export function bumpVersion(version: string): string {
	const [maj, min, patch] = version.split(".").map((s) => Number(s));
	return `${maj}.${min}.${(patch ?? 0) + 1}`;
}

/** Produce the new template doc. Throws only if the result would not execute. */
export function applyProposal(template: RunnerTemplateDoc, proposal: Proposal): RunnerTemplateDoc {
	const gate = gateProposal(template, proposal);
	if (!gate.ok) throw new Error(`proposal does not produce a runnable template:\n  - ${gate.violations.join("\n  - ")}`);
	const nextGraph = applyEditsToGraph(structuredClone(template.graph), proposal.edits);
	return {
		id: template.id,
		version: bumpVersion(template.version),
		summary: `${template.summary} [challenger: ${proposal.edits.map((e) => e.op).join(", ")}]`,
		graph: nextGraph,
	};
}
