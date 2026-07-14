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
import { CONTROL_PLANE_IDENTITY } from "./control-identity.ts";
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

const REPLAN_SYSTEM = `${CONTROL_PLANE_IDENTITY}
You are the WEA MASTER **escalation replan** agent. A weaker pi worker raised an
ESCALATION — the current plan/graph is stuck or wrong. Workers could not finish
under the old topology; **you** take the hard thinking now.

You receive:
  - the original user task
  - the graph that was running
  - every node attempt so far (summaries, errors, escalate payload)
  - the escalation reason

Your job: invent a BETTER workflow graph and (via prompts) a clearer strategy
for workers. You still do NOT write application code — you re-orchestrate.
Prefer a small, focused graph (2–6 nodes). You may reuse successful upstream
artifacts by naming them in promptTemplates (workers will see prior node outputs
when edges connect them). Put recon on inspector/explorer, coding on implementer,
checks on verifier; put any remaining hard planning into implementer prompts as
concrete steps you authored, not open-ended "design the system" asks.

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
	let completion;
	try {
		completion = await controlComplete(opts.control, {
			system: REPLAN_SYSTEM,
			user,
			maxTokens: 4096,
			temperature: 0.25,
		});
	} catch (err) {
		return {
			ok: false,
			why: `master replan control request failed: ${String((err as Error).message)}`,
			usage: { inputTokens: 0, outputTokens: 0 },
		};
	}
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

const IMPROVE_SYSTEM = `${CONTROL_PLANE_IDENTITY}
You are the WEA MASTER doing **post-run process verification** and workflow
optimization. You are stronger than the workers that just ran — use that to
judge process quality, not to rewrite their code.

You do NOT re-implement the coding task. You review HOW the multi-agent process
went and decide whether the workflow GRAPH should evolve so future runs put hard
planning on control and mechanical work on workers more cleanly.

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
	let completion;
	try {
		completion = await controlComplete(opts.control, {
			system: IMPROVE_SYSTEM,
			user,
			maxTokens: 4096,
			temperature: 0.3,
		});
	} catch (err) {
		return {
			ok: false,
			why: `master improve control request failed: ${String((err as Error).message)}`,
			usage: { inputTokens: 0, outputTokens: 0 },
			applied: false,
		};
	}
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

/** True if this graph node is a proactive WEA master takeover point. */
export function isControlHandoffNode(node: { agentCard: string; controlHandoff?: boolean }): boolean {
	if (node.controlHandoff === true) return true;
	const card = node.agentCard.toLowerCase();
	return card === "master-handoff" || card === "wea-master" || card === "master";
}

export interface MasterHandoffResult {
	ok: boolean;
	why: string;
	/** Authoritative plan for worker implementers (${master_plan}). */
	masterPlan?: string;
	/** Code-edit subgraph to run after the handoff. */
	editGraph?: WorkflowGraph;
	baseId?: string;
	version?: string;
	writtenPath?: string;
	usage: ControlUsage;
	decision?: Record<string, unknown>;
	/** Synthetic node output recorded for the handoff node. */
	output?: NodeOutput;
}

const HANDOFF_SYSTEM = [
	CONTROL_PLANE_IDENTITY,
	"You are at a PROACTIVE HANDOFF point in a workflow graph.",
	"",
	"Cheap pi worker models (explorers / inspectors) already ran. Their findings are in",
	"the context. YOU are the strong model — this is why the graph paused for you.",
	"Actively take on the hard work now:",
	"",
	"1. Resolve conflicts / noise in upstream findings (you decide which approach wins)",
	"2. Synthesize a precise MASTER IMPLEMENTATION PLAN (architecture-level choices yours)",
	"3. Choose (or invent) a CODE-EDIT subgraph that weaker coding workers will run",
	"   with your plan injected as context",
	"",
	"You do NOT edit the repository yourself. Workers will implement YOUR plan.",
	"If the task is hard, make the hard decisions in master_plan — do not leave",
	"open design questions for the implementer.",
	"",
	"Prefer the standard implement→verify shape unless the task needs something else:",
	"  implement (implementer) → verify (verifier) + optional FEEDBACK fix loop",
	"For pure bugfix after localization, patch→regression is fine:",
	"  patch (implementer) → regression (verifier) + FEEDBACK fix loop",
	"Stage templates you may mirror: t-implement-verify, t-patch-regression.",
	"",
	"OUTPUT: exactly one JSON object, no markdown:",
	"",
	"{",
	'  "decision": "handoff",',
	'  "master_plan": {',
	'    "summary": "<one sentence>",',
	'    "approach": "<how to implement>",',
	'    "change_surface": ["path or path:symbol", ...],',
	'    "steps": ["<ordered step>", ...],',
	'    "acceptance": ["<how to know it worked>", ...],',
	'    "risks": ["..."],',
	'    "rejected_upstream": [{"from": "<explorer>", "reason": "..."}]',
	"  },",
	'  "edit_graph": {',
	'    "id": "edit-<short-slug>",',
	'    "version": "1.0.0",',
	'    "summary": "<one line>",',
	'    "graph": {',
	'      "nodes": [',
	"        {",
	'          "id": "implement",',
	'          "kind": "worker",',
	'          "agentCard": "implementer",',
	'          "trigger": "ALL_SUCCESS",',
	'          "promptTemplate": "Task:\\n${task}\\n\\nMaster plan:\\n${master_plan}\\n\\nUpstream:\\n${upstream}\\n\\nImplement the master plan. Produce JSON report."',
	"        },",
	"        {",
	'          "id": "verify",',
	'          "kind": "verifier",',
	'          "agentCard": "verifier",',
	'          "trigger": "ALL_SUCCESS",',
	'          "promptTemplate": "Task:\\n${task}\\n\\nMaster plan:\\n${master_plan}\\n\\nImplementer:\\n${upstream}\\n\\nVerify. Produce verdict JSON."',
	"        }",
	"      ],",
	'      "edges": [',
	'        { "id": "e_in", "from": "@input", "to": "implement", "kind": "DATA" },',
	'        { "id": "e_iv", "from": "implement", "to": "verify", "kind": "DATA" },',
	'        { "id": "e_out", "from": "verify", "to": "@output", "kind": "DATA" },',
	'        { "id": "e_fix", "from": "verify", "to": "implement", "kind": "FEEDBACK", "loopId": "fix" }',
	"      ],",
	'      "loops": [',
	'        { "id": "fix", "bodyNodes": ["implement", "verify"], "feedbackEdges": ["e_fix"], "maxIterations": 2 }',
	"      ]",
	"    }",
	"  },",
	'  "reasoning": "<why this plan and this edit graph>"',
	"}",
	"",
	"Rules:",
	"  - master_plan must be concrete enough that a weaker coding model can execute it",
	"  - every edit_graph node needs ≥1 non-FEEDBACK incoming edge",
	"  - @input reaches @output; no cycles outside FEEDBACK",
	"  - agent cards: inspector, explorer, aggregator, implementer, verifier only",
	"    (do NOT put master-handoff inside the edit graph)",
	"  - omit per-node model fields",
	"  - prefer 2–4 nodes in the edit graph",
].join("\n");

/**
 * Proactive handoff: strong WEA model consumes explorer/upstream context,
 * writes a master plan, and returns a code-edit graph for workers.
 */
export async function masterHandoff(opts: {
	control: WeaControlConfig;
	task: string;
	currentGraph: WorkflowGraph;
	templateRef: string;
	handoffNodeId: string;
	upstream: NodeRunRecord[];
	allRecords: NodeRunRecord[];
	persist?: boolean;
	onLog?: (m: string) => void;
}): Promise<MasterHandoffResult> {
	const log = opts.onLog ?? (() => {});
	const upstreamBrief = opts.upstream.map((r) => ({
		nodeId: r.nodeId,
		status: r.status,
		output: r.output,
	}));
	const priorBrief = opts.allRecords.map((r) => ({
		nodeId: r.nodeId,
		attemptNo: r.attemptNo,
		status: r.status,
		summary: r.output?.summary ?? r.error?.message ?? null,
	}));

	const user = [
		"## Original task",
		opts.task,
		"",
		"## Template / phase that reached the handoff",
		opts.templateRef,
		`handoff node: ${opts.handoffNodeId}`,
		"",
		"## Current graph (explore phase)",
		JSON.stringify(opts.currentGraph, null, 2),
		"",
		"## Direct upstream into the handoff (explorers etc.)",
		JSON.stringify(upstreamBrief, null, 2),
		"",
		"## All node attempts so far",
		JSON.stringify(priorBrief, null, 2),
		"",
		"You are taking over. Emit master_plan + edit_graph JSON now.",
	].join("\n");

	log(`[master] proactive handoff at ${opts.handoffNodeId} via ${opts.control.modelId}`);
	let completion;
	try {
		completion = await controlComplete(opts.control, {
			system: HANDOFF_SYSTEM,
			user,
			maxTokens: 4096,
			temperature: 0.25,
		});
	} catch (err) {
		return {
			ok: false,
			why: `master handoff control request failed: ${String((err as Error).message)}`,
			usage: { inputTokens: 0, outputTokens: 0 },
		};
	}
	const usage = completion.usage;
	const decision = parseJsonObject(completion.text);
	if (!decision) {
		return { ok: false, why: "master handoff returned unparseable JSON", usage };
	}

	const planObj = decision.master_plan ?? decision.plan;
	if (!planObj) {
		return { ok: false, why: "master handoff missing master_plan", usage, decision };
	}
	const masterPlan =
		typeof planObj === "string" ? planObj : JSON.stringify(planObj, null, 2);

	// edit_graph may be { id, version, summary, graph } or raw graph
	let editGraph: WorkflowGraph | undefined;
	let baseId = "edit-from-handoff";
	let version = "1.0.0";
	let summary = "Code-edit graph from master handoff";
	const eg = decision.edit_graph as any;
	if (eg?.graph?.nodes) {
		editGraph = eg.graph as WorkflowGraph;
		baseId = String(eg.id ?? baseId).replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
		version = String(eg.version ?? version);
		summary = String(eg.summary ?? summary);
	} else if (eg?.nodes) {
		editGraph = eg as WorkflowGraph;
	} else if ((decision as any).graph?.nodes) {
		editGraph = (decision as any).graph as WorkflowGraph;
	}

	if (!editGraph) {
		// Fallback: standard implement→verify with master_plan placeholders
		editGraph = defaultImplementVerifyGraph();
		baseId = "t-implement-verify";
		log("[master] handoff used default t-implement-verify edit graph");
	}
	if (!Array.isArray(editGraph.loops)) editGraph.loops = [];
	for (const n of editGraph.nodes) {
		delete (n as any).model;
		delete (n as any).controlHandoff;
		// Never nest another handoff inside the edit phase
		if (isControlHandoffNode(n)) {
			n.agentCard = "implementer";
			n.kind = "worker";
		}
	}

	const issues = structuralIssuesOfGraph(editGraph);
	if (issues.length) {
		return {
			ok: false,
			why: `master handoff edit graph not runnable: ${issues.join("; ")}`,
			masterPlan,
			usage,
			decision,
		};
	}

	let writtenPath: string | undefined;
	if (opts.persist !== false) {
		const doc: RunnerTemplateDoc = { id: baseId, version, summary, graph: editGraph };
		writtenPath = join(TEMPLATES_DIR, `${baseId}@${version}.json`);
		mkdirSync(dirname(writtenPath), { recursive: true });
		writeFileSync(writtenPath, JSON.stringify(doc, null, 2) + "\n");
		log(`[master] wrote edit graph ${writtenPath}`);
	}

	const output: NodeOutput = {
		summary:
			typeof planObj === "object" && planObj && "summary" in (planObj as object)
				? String((planObj as any).summary)
				: `master plan for edit graph ${baseId}`,
		master_plan: planObj,
		edit_graph_id: baseId,
		edit_graph_version: version,
		reasoning: decision.reasoning ?? null,
		handoff: true,
	};

	return {
		ok: true,
		why: `master:handoff → plan + ${baseId} — ${String(decision.reasoning ?? "").slice(0, 160)}`,
		masterPlan,
		editGraph,
		baseId,
		version,
		writtenPath,
		usage,
		decision,
		output,
	};
}

function defaultImplementVerifyGraph(): WorkflowGraph {
	return {
		nodes: [
			{
				id: "implement",
				kind: "worker",
				agentCard: "implementer",
				trigger: "ALL_SUCCESS",
				promptTemplate:
					"Task:\n${task}\n\nMaster plan (from WEA control — follow this):\n${master_plan}\n\nUpstream (verifier feedback on fix passes):\n${upstream}\n\nImplement exactly the master plan. Produce the JSON report.",
			},
			{
				id: "verify",
				kind: "verifier",
				agentCard: "verifier",
				trigger: "ALL_SUCCESS",
				promptTemplate:
					"Task:\n${task}\n\nMaster plan:\n${master_plan}\n\nImplementer report:\n${upstream}\n\nIndependently verify. Produce the verdict JSON.",
			},
		],
		edges: [
			{ id: "e_in_impl", from: "@input", to: "implement", kind: "DATA" },
			{ id: "e_impl_verify", from: "implement", to: "verify", kind: "DATA" },
			{ id: "e_verify_out", from: "verify", to: "@output", kind: "DATA" },
			{ id: "e_fix_loop", from: "verify", to: "implement", kind: "FEEDBACK", loopId: "fix" },
		],
		loops: [
			{ id: "fix", bodyNodes: ["implement", "verify"], feedbackEdges: ["e_fix_loop"], maxIterations: 2 },
		],
	};
}
