/**
 * Master-agent loops (control plane / WEA_*).
 *
 * 1) Escalation replan — a worker node may raise escalate=true in its JSON
 *    output. The orchestrator freezes the current graph, packs the full
 *    context, and asks the WEA control LLM for a replacement graph.
 *
 * 2) Post-run improve — after a task finishes, the same control LLM reviews
 *    the process (not only the code) and may emit a wea.proposal/v2 to evolve
 *    the template that just ran.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	applyProposal,
	gateProposal,
	structuralIssuesOfGraph,
	type Proposal,
	type RunnerTemplateDoc,
} from "./template-edit.ts";
import type { NodeOutput, NodeRunRecord, WorkflowGraph } from "./types.ts";
import {
	controlComplete,
	parseJsonObject,
	type ControlUsage,
	type WeaControlConfig,
} from "./wea-control.ts";

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "library", "templates");

export interface EscalationSignal {
	nodeId: string;
	attemptNo: number;
	reason: string;
	context: unknown;
	/** Raw node output that triggered the escalate. */
	output: NodeOutput;
}

/** Detect escalate flag on a worker's JSON output. */
export function detectEscalation(
	nodeId: string,
	attemptNo: number,
	output: NodeOutput | null,
	status: string,
): EscalationSignal | null {
	if (!output || typeof output !== "object") return null;
	const o = output as Record<string, unknown>;
	const flag =
		o.escalate === true ||
		o.escalate === "true" ||
		o.exception === true ||
		String(o.verdict ?? "").toLowerCase() === "escalate" ||
		String(o.status ?? "").toLowerCase() === "escalate";
	if (!flag) return null;
	const reason =
		String(o.escalate_reason ?? o.exception_reason ?? o.reason ?? o.summary ?? "worker requested master replan");
	const context = o.escalate_context ?? o.exception_context ?? o.context ?? null;
	return { nodeId, attemptNo, reason, context, output };
}

export interface ReplanResult {
	ok: boolean;
	why: string;
	graph?: WorkflowGraph;
	baseId?: string;
	version?: string;
	writtenPath?: string;
	usage: ControlUsage;
	decision?: Record<string, unknown>;
}

const REPLAN_SYSTEM = `You are the WEA MASTER control agent. A worker node on the current workflow
graph raised an ESCALATION (exception). The current plan is stuck or wrong.

You receive:
  - the original user task
  - the graph that was running
  - every node attempt so far (summaries, errors, escalate payload)
  - the escalation reason

Your job: invent a BETTER workflow graph to continue (or restart) the task.
Prefer a small, focused graph (2–6 nodes). You may reuse successful upstream
artifacts by naming them in promptTemplates (workers will see prior node outputs
when edges connect them).

Agent cards: inspector, explorer, aggregator, implementer, verifier
Node kinds: planner | worker | verifier | aggregator
Triggers: ALL_SUCCESS | ANY_SUCCESS
Edges: DATA | CONTROL | FEEDBACK (FEEDBACK needs loopId + loops entry)
Ports: @input, @output

OUTPUT: exactly one JSON object, no markdown:

{
  "decision": "replan",
  "id": "replan-<short-slug>",
  "version": "1.0.0",
  "summary": "<one line>",
  "reasoning": "<why the previous graph failed and what this one fixes>",
  "resume_strategy": "restart" | "continue",
  "graph": {
    "nodes": [ { "id", "kind", "agentCard", "trigger", "promptTemplate" } ],
    "edges": [ { "id", "from", "to", "kind", "loopId?" } ],
    "loops": []
  }
}

Rules:
  - every node needs ≥1 non-FEEDBACK incoming edge
  - @input reaches @output on non-FEEDBACK edges
  - no cycles outside FEEDBACK loops
  - omit per-node "model" fields
  - do NOT put secrets or absolute paths in prompts
  - promptTemplate may use \${task} and \${upstream}
  - if the situation is hopeless, still emit a minimal inspect→report graph
    that documents the blocker instead of inventing fake progress`;

export async function masterReplan(opts: {
	control: WeaControlConfig;
	task: string;
	failedGraph: WorkflowGraph;
	templateRef: string;
	records: NodeRunRecord[];
	escalation: EscalationSignal;
	persist?: boolean;
	onLog?: (m: string) => void;
}): Promise<ReplanResult> {
	const log = opts.onLog ?? (() => {});
	const compactRecords = opts.records.map((r) => ({
		nodeId: r.nodeId,
		attemptNo: r.attemptNo,
		status: r.status,
		summary: r.output?.summary ?? r.error?.message ?? null,
		error: r.error,
		output: r.output
			? {
					summary: r.output.summary,
					verdict: (r.output as any).verdict,
					escalate: (r.output as any).escalate,
					must_fix: (r.output as any).must_fix,
					concerns: (r.output as any).concerns,
					files_changed: (r.output as any).files_changed,
				}
			: null,
	}));

	const user = [
		"## Original task",
		opts.task,
		"",
		"## Template that was running",
		opts.templateRef,
		"",
		"## Graph that failed / escalated",
		JSON.stringify(opts.failedGraph, null, 2),
		"",
		"## Escalation from worker",
		JSON.stringify(
			{
				nodeId: opts.escalation.nodeId,
				attemptNo: opts.escalation.attemptNo,
				reason: opts.escalation.reason,
				context: opts.escalation.context,
				output: opts.escalation.output,
			},
			null,
			2,
		),
		"",
		"## All node attempts so far",
		JSON.stringify(compactRecords, null, 2),
		"",
		"Emit a replacement graph JSON now.",
	].join("\n");

	log(`[master] escalation replan via ${opts.control.modelId} (from node ${opts.escalation.nodeId})`);
	const completion = await controlComplete(opts.control, {
		system: REPLAN_SYSTEM,
		user,
		maxTokens: 4096,
		temperature: 0.25,
	});
	const usage = completion.usage;
	const decision = parseJsonObject(completion.text);
	if (!decision) {
		return { ok: false, why: "master replan returned unparseable JSON", usage };
	}

	const graph = decision.graph as WorkflowGraph | undefined;
	if (!graph?.nodes?.length || !Array.isArray(graph.edges)) {
		return { ok: false, why: "master replan missing graph.nodes/edges", usage, decision };
	}
	if (!Array.isArray(graph.loops)) graph.loops = [];
	for (const n of graph.nodes) delete (n as any).model;

	const issues = structuralIssuesOfGraph(graph);
	if (issues.length) {
		return {
			ok: false,
			why: `master replan not runnable: ${issues.join("; ")}`,
			usage,
			decision,
		};
	}

	const idRaw = String(decision.id ?? "replan").replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
	const baseId = idRaw.startsWith("replan") ? idRaw : `replan-${idRaw}`;
	const version = String(decision.version ?? "1.0.0");
	const summary = String(decision.summary ?? `Replan after escalate from ${opts.escalation.nodeId}`);

	let writtenPath: string | undefined;
	if (opts.persist !== false) {
		const doc: RunnerTemplateDoc = { id: baseId, version, summary, graph };
		writtenPath = join(TEMPLATES_DIR, `${baseId}.json`);
		mkdirSync(dirname(writtenPath), { recursive: true });
		writeFileSync(writtenPath, JSON.stringify(doc, null, 2) + "\n");
		log(`[master] wrote replan template ${writtenPath}`);
	}

	return {
		ok: true,
		why: `master:replan ${baseId} — ${String(decision.reasoning ?? "").slice(0, 200)}`,
		graph,
		baseId,
		version,
		writtenPath,
		usage,
		decision,
	};
}

export interface ImproveResult {
	ok: boolean;
	why: string;
	proposal?: Proposal;
	nextVersion?: string;
	writtenPath?: string;
	usage: ControlUsage;
	applied: boolean;
}

const IMPROVE_SYSTEM = `You are the WEA MASTER control agent doing POST-RUN process verification
and workflow optimization.

You do NOT re-implement the coding task. You review HOW the multi-agent process
went and decide whether the workflow GRAPH should evolve.

Emit wea.proposal/v2 to adapt the template that just ran, OR empty edits if the
process was already good.

OUTPUT: exactly one JSON object, no markdown:

{
  "schema": "wea.proposal/v2",
  "target_template": "<id>",
  "target_version": "<version>",
  "process_verdict": "good" | "needs_improve" | "broken",
  "process_review": "<what worked / what failed in the PROCESS>",
  "edits": [ /* remove_node | add_node | edit_prompt | add_edge | remove_edge | set_loop | remove_loop */ ],
  "reasoning": "<why these edits>",
  "hypothesis": "<what A/B would test>",
  "expected_effect": "<predicted delta>"
}

Rules:
  - empty edits when process_verdict is "good"
  - prefer small edits (prompt tightening, add verifier, drop redundant explorer)
  - omit per-node model fields
  - agent cards: inspector, explorer, aggregator, implementer, verifier`;

export async function masterImprove(opts: {
	control: WeaControlConfig;
	task: string;
	templateRef: string;
	templateVersion: string;
	graph: WorkflowGraph;
	status: "success" | "failure";
	records: NodeRunRecord[];
	escalations?: EscalationSignal[];
	persist?: boolean;
	apply?: boolean;
	onLog?: (m: string) => void;
}): Promise<ImproveResult> {
	const log = opts.onLog ?? (() => {});
	const baseId = opts.templateRef.split("@", 1)[0]!;
	const compact = opts.records.map((r) => ({
		nodeId: r.nodeId,
		attemptNo: r.attemptNo,
		status: r.status,
		summary: r.output?.summary ?? r.error?.message ?? null,
		tokens: r.usage.reduce((a, u) => a + u.input + u.output, 0),
		tools: r.toolCalls.map((t) => t.tool),
		verdict: (r.output as any)?.verdict,
		files_changed: (r.output as any)?.files_changed,
		must_fix: (r.output as any)?.must_fix,
	}));

	const user = [
		"## Task",
		opts.task,
		"",
		"## Run outcome",
		JSON.stringify({
			status: opts.status,
			templateRef: opts.templateRef,
			templateVersion: opts.templateVersion,
			escalations: opts.escalations ?? [],
		}),
		"",
		"## Graph that ran",
		JSON.stringify(opts.graph, null, 2),
		"",
		"## Node process log",
		JSON.stringify(compact, null, 2),
		"",
		"Review the PROCESS and emit wea.proposal/v2 to improve the template (or empty edits).",
	].join("\n");

	log(`[master] post-run improve via ${opts.control.modelId} for ${opts.templateRef}`);
	const completion = await controlComplete(opts.control, {
		system: IMPROVE_SYSTEM,
		user,
		maxTokens: 4096,
		temperature: 0.3,
	});
	const usage = completion.usage;
	const parsed = parseJsonObject(completion.text);
	if (!parsed) {
		return { ok: false, why: "master improve returned unparseable JSON", usage, applied: false };
	}

	const proposal = parsed as unknown as Proposal;
	if (!proposal.schema) (proposal as any).schema = "wea.proposal/v2";
	proposal.target_template = baseId;
	proposal.target_version = opts.templateVersion;
	if (!Array.isArray(proposal.edits)) proposal.edits = [];

	const processVerdict = String((parsed as any).process_verdict ?? "?");
	const processReview = String((parsed as any).process_review ?? "").slice(0, 240);

	if (proposal.edits.length === 0) {
		return {
			ok: true,
			why: `master:improve no-op [${processVerdict}] — ${processReview || "process already good"}`,
			proposal,
			usage,
			applied: false,
		};
	}

	const doc: RunnerTemplateDoc = {
		id: baseId,
		version: opts.templateVersion,
		summary: opts.templateRef,
		graph: structuredClone(opts.graph),
	};
	const gate = gateProposal(doc, proposal);
	if (!gate.ok) {
		return {
			ok: false,
			why: `master:improve structural gate failed: ${gate.violations.join("; ")}`,
			proposal,
			usage,
			applied: false,
		};
	}

	const apply = opts.apply !== false && opts.persist !== false;
	if (!apply) {
		return {
			ok: true,
			why: `master:improve proposal ready [${processVerdict}] (${proposal.edits.map((e) => e.op).join(", ")}) — not applied`,
			proposal,
			usage,
			applied: false,
		};
	}

	const next = applyProposal(doc, proposal);
	for (const n of next.graph.nodes) delete n.model;
	const writtenPath = join(TEMPLATES_DIR, `${next.id}@${next.version}.json`);
	mkdirSync(dirname(writtenPath), { recursive: true });
	writeFileSync(writtenPath, JSON.stringify(next, null, 2) + "\n");
	log(`[master] wrote improved challenger ${writtenPath}`);

	return {
		ok: true,
		why: `master:improve applied [${processVerdict}] ${next.id}@${next.version} — ${processReview}`,
		proposal,
		nextVersion: next.version,
		writtenPath,
		usage,
		applied: true,
	};
}

export function mergeUsage(a: ControlUsage, b: ControlUsage): ControlUsage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
	};
}
