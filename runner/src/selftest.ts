/**
 * Offline self-test for Phases 3–5 — no network, no API spend, no Python.
 * Run:  tsx src/selftest.ts   (exits non-zero on any failure)
 *
 * Covers:
 *   Phase 3 retrieval  — a bugfix task routes to t2-bugfix; a "parallel explore"
 *                        task finds t3-complex by shape tags alone.
 *   Phase 4 cache      — a read-only node stores + hits on an identical world;
 *                        any world change misses; bash/write nodes refuse to
 *                        cache (fail-closed).
 *   Phase 5 champion   — promote a clean win, reject a quality regression, and
 *                        reject the real polluted A/B as inconclusive; alias
 *                        moves on a win and holds on a loss.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExactCache, isCacheable } from "./cache.ts";
import { currentChampion, judge, runChampionGate } from "./champion.ts";
import { GraphScheduler } from "./graph.ts";
import { detectEscalation } from "./master-loop.ts";
import {
	computeRunStatus,
	renderPrompt,
	upstreamOutputs,
} from "./orchestrator.ts";
import { retrieve } from "./retrieval.ts";
import { planOffline } from "./plan.ts";
import { formatWeaNow, withCurrentTime } from "./time-banner.ts";
import { captureWorkspaceResult, prepareIsolatedWorkspace, removeIsolatedWorkspace } from "./workspace.ts";
import { validateAgentOutput, validateWorkflowGraph } from "./schemas.ts";
import { applyProposal, gateProposal, type RunnerTemplateDoc } from "./template-edit.ts";
import { publishBaseTemplate, publishVersionedTemplate } from "./template-store.ts";
import { listTemplateDocuments, saveTemplateDocument, TemplateRequestError, validateEditableGraph } from "./template-service.ts";
import { buildComplianceTrace, buildPvfTrace, newTraceId, type RunManifest } from "./trace-export.ts";
import { controlComplete, loadWeaControlConfig } from "./wea-control.ts";
import type { NodeRunRecord, WorkflowGraph } from "./types.ts";

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`${cond ? "  ✓" : "  ✗ FAIL"}  ${name}`);
	if (!cond) failures += 1;
}

// ---- Phase 3 ----------------------------------------------------------------
console.log("Phase 3 — retrieval");
{
	const bug = retrieve({ goal: "the test fails, fix the off-by-one bug", family: "bugfix", hasOracle: true });
	check("bugfix task → t2-bugfix", bug[0]!.id === "t2-bugfix");
	// Query stresses fanout+merge shape without the word "feature" (which routes to t-feature-master).
	const cx = retrieve({ goal: "need parallel exploration and merging of approaches" });
	check("parallel/merge task → t3-complex via shape tags", cx[0]!.id === "t3-complex");
	const blank = retrieve({ goal: "" });
	check("no-signal task → safe-generic fallback", blank[0]!.id === "t1-safe-generic");
	const readMaster = retrieve({ goal: "inspect the repo then handoff to master for a complex change", family: "read" });
	check("read/handoff family → t-read-master", readMaster[0]!.id === "t-read-master");
	const featMaster = retrieve({ goal: "add a new API endpoint following existing patterns", family: "feature" });
	check("feature family → t-feature-master", featMaster[0]!.id === "t-feature-master");
	const offlineFeature = planOffline({ task: "add a new API endpoint", family: "feature", offline: true });
	check(
		"offline planner never selects a control-handoff graph",
		!offlineFeature.graph.nodes.some((node) => node.controlHandoff || node.agentCard === "master-handoff"),
	);
}

// ---- Phase 4 ----------------------------------------------------------------
console.log("Phase 4 — exact cache");
{
	const base: NodeRunRecord = {
		nodeId: "inspect", attemptNo: 1, graphGeneration: 0, agentCard: "inspector", kind: "planner",
		sessionId: "s1", systemPromptDigest: "sha256:" + "a".repeat(64),
		toolCalls: [{ tool: "read", toolCallId: "t", input: { path: "a.ts" } }], toolResults: [],
		usage: [], finalText: '{"summary":"ok"}', output: { summary: "ok" },
		status: "success", error: null, plannedAt: "", readyAt: "", startedAt: "", endedAt: "",
		readSet: ["a.ts"], writeSet: [], observations: [], usedBash: false, redactions: 0,
	};
	check("read-only node is cacheable", isCacheable(base).ok);
	check("bash node is NOT cacheable", !isCacheable({ ...base, usedBash: true }).ok);
	check("writing node is NOT cacheable", !isCacheable({ ...base, writeSet: ["a.ts"] }).ok);

	const cache = new ExactCache(mkdtempSync(join(tmpdir(), "wea-cache-")));
	const parts = { systemPromptDigest: base.systemPromptDigest, taskPrompt: "inspect a.ts", modelId: "sonnet-5", repoSnapshotDigest: "sha256:" + "c".repeat(64) };
	check("miss before store", !cache.lookup(parts).hit);
	check("store read-only ok", cache.store(parts, base).stored);
	check("store bash refused", !cache.store({ ...parts, taskPrompt: "x" }, { ...base, usedBash: true }).stored);
	const hit = cache.lookup(parts);
	check("hit on identical world", hit.hit && JSON.stringify((hit as any).output) === '{"summary":"ok"}');
	check("miss on changed snapshot", !cache.lookup({ ...parts, repoSnapshotDigest: "sha256:" + "d".repeat(64) }).hit);
	check("miss on changed prompt", !cache.lookup({ ...parts, taskPrompt: "z" }).hit);
	check("miss on changed model", !cache.lookup({ ...parts, modelId: "haiku" }).hit);
}

// ---- Phase 5 ----------------------------------------------------------------
console.log("Phase 5 — champion gate");
{
	const arm = (ref: string, tokens: number[], dollars: number[], passes: boolean[]) => ({ templateRef: ref, tokens, dollars, passes });
	const champ = arm("t3-complex", [3400, 3350, 3450], [0.118, 0.117, 0.119], [true, true, true]);
	const win = arm("t3-complex@1.0.1", [2800, 2750, 2820], [0.1, 0.099, 0.101], [true, true, true]);
	check("clean win promotes", judge(champ, win).promote);
	const worse = arm("t3-complex@1.0.2", [2000, 2100, 2050], [0.07, 0.07, 0.07], [true, false, true]);
	check("quality regression rejected", !judge(champ, worse).promote);
	const polluted = judge(arm("t3-complex", [3355], [0.1184], [true]), arm("t3-complex@1.0.1", [5500], [0.1064], [true]));
	check("polluted A/B rejected as inconclusive", !polluted.promote);

	const dir = mkdtempSync(join(tmpdir(), "wea-champ-"));
	check("default champion is the base id", currentChampion("t3-complex", dir) === "t3-complex");
	const r1 = runChampionGate(champ, win, dir);
	check("win moves alias to challenger", r1.championRef === "t3-complex@1.0.1" && currentChampion("t3-complex", dir) === "t3-complex@1.0.1");
	const r2 = runChampionGate(arm("t3-complex@1.0.1", [2800], [0.1], [true]), arm("t3-complex@1.0.2", [2790], [0.099], [false]), dir);
	check("loss holds the alias", r2.championRef === "t3-complex@1.0.1" && currentChampion("t3-complex", dir) === "t3-complex@1.0.1");
}

// ---- Correctness regressions (generation scope, escalate, loop, render) -----
console.log("Correctness — generation scope / escalate / loop / renderPrompt");
{
	const mk = (
		overrides: Partial<NodeRunRecord> & Pick<NodeRunRecord, "nodeId" | "attemptNo" | "status">,
	): NodeRunRecord => ({
		graphGeneration: 0,
		agentCard: "x",
		kind: "worker",
		sessionId: "s",
		systemPromptDigest: "sha256:" + "a".repeat(64),
		toolCalls: [],
		toolResults: [],
		usage: [],
		finalText: "{}",
		output: { summary: overrides.nodeId },
		error: null,
		plannedAt: "2020-01-01T00:00:00.000Z",
		readyAt: "2020-01-01T00:00:00.000Z",
		startedAt: "2020-01-01T00:00:00.000Z",
		endedAt: "2020-01-01T00:00:00.000Z",
		readSet: [],
		writeSet: [],
		observations: [],
		usedBash: false,
		redactions: 0,
		...overrides,
	});

	// (a) Two-generation records: old attempt must not flip status / upstream.
	const graphGen: WorkflowGraph = {
		nodes: [
			{ id: "implement", kind: "worker", agentCard: "implementer", trigger: "ALL_SUCCESS", promptTemplate: "test" },
			{ id: "verify", kind: "verifier", agentCard: "verifier", trigger: "ALL_SUCCESS", promptTemplate: "test" },
		],
		edges: [
			{ id: "e1", from: "@input", to: "implement", kind: "DATA" },
			{ id: "e2", from: "implement", to: "verify", kind: "DATA" },
			{ id: "e3", from: "verify", to: "@output", kind: "DATA" },
		],
		loops: [],
	};
	// Gen0: implement+verify succeeded (stale phase after replan/handoff).
	// Gen1: same nodeIds at attemptNo=1, but verify failed — active phase must win.
	const multiGen: NodeRunRecord[] = [
		mk({
			nodeId: "implement",
			attemptNo: 1,
			graphGeneration: 0,
			status: "success",
			endedAt: "2020-01-01T00:00:01.000Z",
			output: { summary: "old implement" },
		}),
		mk({
			nodeId: "verify",
			attemptNo: 1,
			graphGeneration: 0,
			status: "success",
			endedAt: "2020-01-01T00:00:02.000Z",
			output: { summary: "old verify", verdict: "pass" },
		}),
		mk({
			nodeId: "implement",
			attemptNo: 1,
			graphGeneration: 1,
			status: "success",
			endedAt: "2020-01-01T00:00:03.000Z",
			output: { summary: "new implement" },
		}),
		mk({
			nodeId: "verify",
			attemptNo: 1,
			graphGeneration: 1,
			status: "failure",
			endedAt: "2020-01-01T00:00:04.000Z",
			output: { summary: "new verify failed", verdict: "fail" },
			error: { code: "X", message: "fail", retryable: false },
		}),
	];
	check(
		"two-generation: active gen failure is not flipped by old success",
		computeRunStatus(multiGen, graphGen, true) === "failure",
	);
	const up = upstreamOutputs("verify", graphGen, multiGen);
	check(
		"two-generation: upstreamOutputs prefers active generation",
		up.length === 1 && up[0]!.output?.summary === "new implement" && up[0]!.graphGeneration === 1,
	);

	// Runtime contracts: malformed verifier output and dangling feedback loops fail closed.
	check("verifier output requires verdict/checks/must_fix", !validateAgentOutput("verifier", {}).ok);
	const danglingLoop: WorkflowGraph = {
		nodes: [
			{ id: "implement", kind: "worker", agentCard: "implementer", trigger: "ALL_SUCCESS", promptTemplate: "test" },
			{ id: "verify", kind: "verifier", agentCard: "verifier", trigger: "ALL_SUCCESS", promptTemplate: "test" },
		],
		edges: [
			{ id: "e_in", from: "@input", to: "implement", kind: "DATA" },
			{ id: "e_iv", from: "implement", to: "verify", kind: "DATA" },
			{ id: "e_out", from: "verify", to: "@output", kind: "DATA" },
			{ id: "e_feedback", from: "verify", to: "implement", kind: "FEEDBACK", loopId: "missing" },
		],
		loops: [],
	};
	check("graph schema rejects feedback edge with missing loop", !validateWorkflowGraph(danglingLoop).ok);

	// A fix-pass implementer must receive the verifier's FEEDBACK output as prompt context.
	const feedbackGraph: WorkflowGraph = {
		nodes: [
			{ id: "inspect", kind: "planner", agentCard: "inspector", trigger: "ALL_SUCCESS", promptTemplate: "test" },
			{ id: "implement", kind: "worker", agentCard: "implementer", trigger: "ALL_SUCCESS", promptTemplate: "test" },
			{ id: "verify", kind: "verifier", agentCard: "verifier", trigger: "ALL_SUCCESS", promptTemplate: "test" },
		],
		edges: [
			{ id: "e_in", from: "@input", to: "inspect", kind: "DATA" },
			{ id: "e_plan", from: "inspect", to: "implement", kind: "DATA" },
			{ id: "e_iv", from: "implement", to: "verify", kind: "DATA" },
			{ id: "e_out", from: "verify", to: "@output", kind: "DATA" },
			{ id: "e_feedback", from: "verify", to: "implement", kind: "FEEDBACK", loopId: "fix" },
		],
		loops: [{ id: "fix", bodyNodes: ["implement", "verify"], feedbackEdges: ["e_feedback"], maxIterations: 2 }],
	};
	const feedbackRecords = [
		mk({ nodeId: "inspect", attemptNo: 1, status: "success", output: { summary: "plan" }, endedAt: "2020-01-01T00:00:01.000Z" }),
		mk({ nodeId: "verify", attemptNo: 1, status: "success", output: { summary: "failed", verdict: "fail", must_fix: ["edge case"] }, endedAt: "2020-01-01T00:00:02.000Z" }),
	];
	const firstPassInputs = upstreamOutputs("implement", feedbackGraph, feedbackRecords);
	const fixPassInputs = upstreamOutputs("implement", feedbackGraph, feedbackRecords, { includeFeedback: true });
	check("first pass excludes FEEDBACK output", firstPassInputs.every((r) => r.nodeId !== "verify"));
	check("fix pass includes verifier FEEDBACK output", fixPassInputs.some((r) => r.nodeId === "verify"));

	// (b) escalate with replan unavailable → failure not success (detect + terminal code path).
	// Pure helper: detectEscalation must fire; the orchestrator terminal-fail path is
	// covered by ensuring ESCALATE_NO_REPLAN semantics when replan is off — we model
	// the post-condition computeRunStatus must see after that path mutates the record.
	const escOut = { summary: "need replan", escalate: true, escalate_reason: "wrong graph" };
	const esc = detectEscalation("implement", 1, escOut, "success");
	check("escalate flag detected on success-status output", !!esc && esc.reason.includes("wrong graph"));
	const escRecord = mk({
		nodeId: "implement",
		attemptNo: 1,
		status: "failure",
		error: { code: "ESCALATE_NO_REPLAN", message: "escalate requested but replan disabled", retryable: false },
		output: escOut,
	});
	const escGraph: WorkflowGraph = {
		nodes: [{ id: "implement", kind: "worker", agentCard: "implementer", trigger: "ALL_SUCCESS", promptTemplate: "test" }],
		edges: [
			{ id: "e1", from: "@input", to: "implement", kind: "DATA" },
			{ id: "e2", from: "implement", to: "@output", kind: "DATA" },
		],
		loops: [],
	};
	check(
		"escalate-no-replan record yields run failure (never success)",
		computeRunStatus([escRecord], escGraph, true) === "failure",
	);
	// Contrast: if we had wrongly left status=success, computeRunStatus would pass — guard that.
	const wrongSuccess = mk({
		nodeId: "implement",
		attemptNo: 1,
		status: "success",
		output: escOut,
	});
	check(
		"(contrast) escalate with status=success would spuriously pass — documents the bug class",
		computeRunStatus([wrongSuccess], escGraph, true) === "success",
	);

	// (c) LOOP_EXHAUSTED with retry requested → feedback source unsuccessful.
	const loopGraph: WorkflowGraph = {
		nodes: [
			{ id: "implement", kind: "worker", agentCard: "implementer", trigger: "ALL_SUCCESS", promptTemplate: "test" },
			{ id: "verify", kind: "verifier", agentCard: "verifier", trigger: "ALL_SUCCESS", promptTemplate: "test" },
		],
		edges: [
			{ id: "e_in", from: "@input", to: "implement", kind: "DATA" },
			{ id: "e_iv", from: "implement", to: "verify", kind: "DATA" },
			{ id: "e_out", from: "verify", to: "@output", kind: "DATA" },
			{ id: "e_fb", from: "verify", to: "implement", kind: "FEEDBACK", loopId: "fix" },
		],
		loops: [{ id: "fix", bodyNodes: ["implement", "verify"], feedbackEdges: ["e_fb"], maxIterations: 1 }],
	};
	const sched = new GraphScheduler(loopGraph);
	sched.sealAll();
	// Drive implement → verify; verify asks for retry at maxIterations=1 → LOOP_EXHAUSTED.
	check("loop: implement ready", sched.readyNodes().includes("implement"));
	sched.markRunning("implement");
	sched.reportSuccess("implement", { summary: "patched" });
	check("loop: verify ready after implement", sched.readyNodes().includes("verify"));
	sched.markRunning("verify");
	sched.reportSuccess("verify", { summary: "still broken", retry: true });
	const verifyRt = sched.runtime.get("verify")!;
	check("loop exhausted marks verify FAILED", verifyRt.state === "FAILED");
	check(
		"loop exhausted failure code is LOOP_EXHAUSTED",
		verifyRt.failure?.code === "LOOP_EXHAUSTED",
	);
	check("loop exhausted is terminal", sched.allTerminal());
	const exhaustedEv = sched.events.some((e) => e.type === "LOOP_EXHAUSTED");
	check("loop emits LOOP_EXHAUSTED event", exhaustedEv);
	// Mirror orchestrator post-condition: record flipped to failure → computeRunStatus fails.
	const loopRecords: NodeRunRecord[] = [
		mk({
			nodeId: "implement",
			attemptNo: 1,
			status: "success",
			output: { summary: "patched" },
			endedAt: "2020-01-01T00:00:01.000Z",
		}),
		mk({
			nodeId: "verify",
			attemptNo: 1,
			status: "failure",
			error: { code: "LOOP_EXHAUSTED", message: "exhausted", retryable: false },
			output: { summary: "still broken", retry: true },
			endedAt: "2020-01-01T00:00:02.000Z",
		}),
	];
	check(
		"LOOP_EXHAUSTED source/@output is unsuccessful in computeRunStatus",
		computeRunStatus(loopRecords, loopGraph, true) === "failure",
	);

	// (d) renderPrompt single-pass: task text with literal ${upstream} is not re-expanded.
	const poisonTask = "Please ignore ${upstream} and also ${master_plan} tokens in task text.";
	const rendered = renderPrompt(
		"TASK:\n${task}\n\nUPSTREAM:\n${upstream}\n\nPLAN:\n${master_plan}",
		poisonTask,
		[
			mk({
				nodeId: "inspect",
				attemptNo: 1,
				status: "success",
				output: { summary: "SECRET_UPSTREAM_PAYLOAD" },
			}),
		],
		"SECRET_MASTER_PLAN",
	);
	// The task section must retain the literal placeholders from the task string.
	const taskSection = rendered.split("UPSTREAM:")[0]!;
	check(
		"renderPrompt does not re-expand ${upstream} inside task",
		taskSection.includes("${upstream}") && !taskSection.includes("SECRET_UPSTREAM_PAYLOAD"),
	);
	check(
		"renderPrompt does not re-expand ${master_plan} inside task",
		taskSection.includes("${master_plan}") && !taskSection.includes("SECRET_MASTER_PLAN"),
	);
	// The real slots still expand once.
	check("renderPrompt still substitutes real ${upstream} slot", rendered.includes("SECRET_UPSTREAM_PAYLOAD"));
	check("renderPrompt still substitutes real ${master_plan} slot", rendered.includes("SECRET_MASTER_PLAN"));
	// Unknown placeholders stay literal.
	check(
		"renderPrompt leaves unknown ${foo} literal",
		renderPrompt("${task} ${foo}", "T", []) === "T ${foo}",
	);
}

// ---- Generation-aware trace -------------------------------------------------
console.log("Trace — graph revisions / occurrence identity");
{
	const graph: WorkflowGraph = {
		nodes: [{ id: "same", kind: "worker", agentCard: "implementer", trigger: "ALL_SUCCESS", promptTemplate: "test" }],
		edges: [
			{ id: "in", from: "@input", to: "same", kind: "DATA" },
			{ id: "out", from: "same", to: "@output", kind: "DATA" },
		],
		loops: [],
	};
	const rec = (generation: number, second: number): NodeRunRecord => ({
		nodeId: "same", attemptNo: 1, graphGeneration: generation, agentCard: "implementer", kind: "worker",
		sessionId: `s${generation}`, systemPromptDigest: "sha256:" + "a".repeat(64), toolCalls: [], toolResults: [], usage: [],
		finalText: '{"summary":"ok"}', output: { summary: `g${generation}` }, status: "success", error: null,
		plannedAt: `2020-01-01T00:00:0${second}.000Z`, readyAt: `2020-01-01T00:00:0${second}.000Z`,
		startedAt: `2020-01-01T00:00:0${second}.000Z`, endedAt: `2020-01-01T00:00:0${second + 1}.000Z`,
		readSet: [], writeSet: [], observations: [], usedBash: false, redactions: 0,
	});
	const manifest: RunManifest = {
		runId: "00000000-0000-4000-8000-000000000099", traceId: newTraceId(), task: "trace generations",
		templateId: "trace-test@1.0.1", templateVersion: "1.0.1", graph,
		graphRevisions: [
			{ generation: 0, templateId: "trace-test", templateVersion: "1.0.0", graph, reason: "initial", startedAt: "2020-01-01T00:00:01.000Z" },
			{ generation: 1, templateId: "trace-test@1.0.1", templateVersion: "1.0.1", graph, reason: "master_replan", startedAt: "2020-01-01T00:00:03.000Z" },
		],
		records: [rec(0, 1), rec(1, 3)], schedulerEvents: [],
		budget: { wallTimeMs: 10_000, modelTokens: 1_000, monetaryMicrounits: 1_000 },
		startedAt: "2020-01-01T00:00:01.000Z", endedAt: "2020-01-01T00:00:04.000Z", status: "success",
		repoRoot: process.cwd(), inputRepoSnapshotDigest: "sha256:" + "b".repeat(64), modelId: "test", piVersion: "test",
	};
	const pvf = buildPvfTrace(manifest) as any;
	const ids = pvf.occurrences.map((o: any) => o.id);
	check("same node/attempt across revisions has unique occurrence ids", ids.join(",") === "g0:same#1,g1:same#1");
	check("cross-generation records do not become executed predecessors", pvf.occurrence_edges.length === 0);
	const compliance = buildComplianceTrace(manifest) as any;
	check("compliance trace carries runtime graph generation", compliance.attempts.map((a: any) => a.runtime_node.generation).join(",") === "0,1");
	check("manifest retains every graph revision", manifest.graphRevisions?.length === 2);
}

// ---- Immutable template publication ----------------------------------------
console.log("Templates — immutable versions / stale target rejection");
{
	const graph: WorkflowGraph = {
		nodes: [{ id: "work", kind: "worker", agentCard: "implementer", trigger: "ALL_SUCCESS", promptTemplate: "old" }],
		edges: [
			{ id: "in", from: "@input", to: "work", kind: "DATA" },
			{ id: "out", from: "work", to: "@output", kind: "DATA" },
		],
		loops: [],
	};
	const dir = mkdtempSync(join(tmpdir(), "wea-templates-"));
	const doc: RunnerTemplateDoc = { id: "immutable", version: "1.0.1", summary: "test", graph };
	const first = publishVersionedTemplate(doc, dir);
	const firstBytes = readFileSync(first.path, "utf8");
	const second = publishVersionedTemplate(doc, dir);
	check("publishing an existing version allocates a new patch version", first.doc.version === "1.0.1" && second.doc.version === "1.0.2");
	check("existing version file is never overwritten", readFileSync(first.path, "utf8") === firstBytes);
	const base1 = publishBaseTemplate({ ...doc, id: "new-base", version: "1.0.0" }, dir);
	const base2 = publishBaseTemplate({ ...doc, id: "new-base", version: "1.0.0" }, dir);
	check("base template collision allocates a new id", base1.doc.id === "new-base" && base2.doc.id === "new-base-2");
	const stale = gateProposal(doc, {
		schema: "wea.proposal/v2", target_template: doc.id, target_version: "1.0.0",
		edits: [{ op: "edit_prompt", node: "work", new_prompt: "new" }],
	});
	check("proposal gate rejects stale target_version", !stale.ok && stale.violations.some((v) => v.includes("not current")));
	const withUi: RunnerTemplateDoc = { ...doc, ui: { positions: { work: { x: 1, y: 2 }, ghost: { x: 3, y: 4 } } } };
	const edited = applyProposal(withUi, {
		schema: "wea.proposal/v2", target_template: doc.id, target_version: doc.version,
		edits: [{ op: "edit_prompt", node: "work", new_prompt: "new" }],
	});
	check("template evolution drops stale editor positions", !!edited.ui?.positions.work && !("ghost" in edited.ui.positions));
}

// ---- GUI template editor service ------------------------------------------
console.log("GUI editor — validate / create / revise / stale conflict");
{
	const dir = mkdtempSync(join(tmpdir(), "wea-gui-templates-"));
	const allowed = new Set(["inspector", "implementer", "verifier", "master-handoff"]);
	const graph: WorkflowGraph = {
		nodes: [
			{ id: "inspect", kind: "planner", agentCard: "inspector", trigger: "ALL_SUCCESS", promptTemplate: "Task: ${task}" },
			{ id: "implement", kind: "worker", agentCard: "implementer", trigger: "ALL_SUCCESS", promptTemplate: "${task}\n${upstream}" },
		],
		edges: [
			{ id: "in", from: "@input", to: "inspect", kind: "DATA" },
			{ id: "plan", from: "inspect", to: "implement", kind: "DATA" },
			{ id: "out", from: "implement", to: "@output", kind: "DATA" },
		],
		loops: [],
	};
	const ui = { positions: { inspect: { x: 100, y: 80 }, implement: { x: 360, y: 80 } } };
	check("editor validation accepts executable graph + layout", validateEditableGraph(graph, ui, allowed).ok);
	check(
		"editor validation rejects unknown agent card",
		!validateEditableGraph({ ...graph, nodes: [{ ...graph.nodes[0]!, agentCard: "missing" }, graph.nodes[1]!] }, ui, allowed).ok,
	);
	const created = saveTemplateDocument(
		{ operation: "create", id: "gui-flow", summary: "GUI flow", graph, ui },
		{ dir, allowedAgentCards: allowed },
	);
	check("GUI create publishes immutable base 1.0.0", created.template.ref === "gui-flow" && created.template.version === "1.0.0");
	check("GUI create persists editor positions", created.template.ui?.positions.inspect?.x === 100);
	const revised = saveTemplateDocument(
		{
			operation: "revise", sourceRef: created.template.ref, sourceVersion: created.template.version,
			summary: "GUI flow revision", graph: { ...graph, nodes: graph.nodes.map((n) => n.id === "implement" ? { ...n, promptTemplate: "revised ${task}" } : n) }, ui,
		},
		{ dir, allowedAgentCards: allowed },
	);
	check("GUI revise publishes exact next patch", revised.template.ref === "gui-flow@1.0.1" && revised.template.version === "1.0.1");
	let staleStatus = 0;
	try {
		saveTemplateDocument(
			{ operation: "revise", sourceRef: created.template.ref, sourceVersion: created.template.version, summary: "stale", graph, ui },
			{ dir, allowedAgentCards: allowed },
		);
	} catch (err) {
		staleStatus = err instanceof TemplateRequestError ? err.status : 500;
	}
	check("GUI stale revision is rejected with conflict", staleStatus === 409);
	const listed = listTemplateDocuments(dir, allowed);
	check("template listing exposes base and versions", listed.map((t) => t.ref).join(",") === "gui-flow,gui-flow@1.0.1");
	check("only newest revision is marked latest", listed.filter((t) => t.isLatest).map((t) => t.ref).join(",") === "gui-flow@1.0.1");
}

// ---- Control transport resilience ------------------------------------------
console.log("Control — timeout / retry / permanent failures");
{
	const cfg = loadWeaControlConfig({
		WEA_BASE_URL: "https://control.invalid", WEA_API_KEY: "secret", WEA_MODEL: "test",
		WEA_CONTROL_TIMEOUT_MS: "25", WEA_CONTROL_MAX_RETRIES: "1",
	});
	check("control env parses timeout and retry settings", cfg?.timeoutMs === 25 && cfg?.maxRetries === 1);
	const originalFetch = globalThis.fetch;
	try {
		let transientCalls = 0;
		globalThis.fetch = (async () => {
			transientCalls += 1;
			if (transientCalls === 1) return new Response('{"error":{"message":"busy"}}', { status: 503 });
			return new Response('{"content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":2,"output_tokens":1}}', { status: 200 });
		}) as typeof fetch;
		const retried = await controlComplete({ baseUrl: "https://control.invalid", apiKey: "secret", modelId: "test", timeoutMs: 100, maxRetries: 1 }, { system: "s", user: "u" });
		check("control retries transient 5xx and returns successful response", transientCalls === 2 && retried.text === "ok");

		let permanentCalls = 0;
		globalThis.fetch = (async () => {
			permanentCalls += 1;
			return new Response('{"error":{"message":"bad request"}}', { status: 400 });
		}) as typeof fetch;
		let permanentMessage = "";
		try {
			await controlComplete({ baseUrl: "https://control.invalid", apiKey: "secret", modelId: "test", timeoutMs: 100, maxRetries: 2 }, { system: "s", user: "u" });
		} catch (err) {
			permanentMessage = (err as Error).message;
		}
		check("control does not retry permanent 4xx", permanentCalls === 1 && permanentMessage.includes("HTTP 400"));

		globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			})) as typeof fetch;
		let timeoutMessage = "";
		try {
			await controlComplete({ baseUrl: "https://control.invalid", apiKey: "secret", modelId: "test", timeoutMs: 10, maxRetries: 0 }, { system: "s", user: "u" });
		} catch (err) {
			timeoutMessage = (err as Error).message;
		}
		check("control aborts an attempt at its deadline", timeoutMessage.includes("timed out after 10ms"));
	} finally {
		globalThis.fetch = originalFetch;
	}
}

// ---- Worktree isolation -----------------------------------------------------
console.log("Worktree isolation — source snapshot / review patch");
{
	const source = mkdtempSync(join(tmpdir(), "wea-source-"));
	execFileSync("git", ["init", "-q"], { cwd: source });
	execFileSync("git", ["config", "user.name", "WEA Test"], { cwd: source });
	execFileSync("git", ["config", "user.email", "wea@test.local"], { cwd: source });
	writeFileSync(join(source, "a.txt"), "base\n");
	execFileSync("git", ["add", "a.txt"], { cwd: source });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: source });
	writeFileSync(join(source, "a.txt"), "user-dirty-baseline\n");
	writeFileSync(join(source, "untracked.txt"), "keep me\n");
	const worktreeBase = mkdtempSync(join(tmpdir(), "wea-worktrees-"));
	const workspace = prepareIsolatedWorkspace({ repo: source, runId: "selftest", worktreeBaseDir: worktreeBase });
	check("isolated baseline includes source dirty tracked content", readFileSync(join(workspace.cwd, "a.txt"), "utf8") === "user-dirty-baseline\n");
	check("isolated baseline includes source untracked files", existsSync(join(workspace.cwd, "untracked.txt")));
	writeFileSync(join(workspace.cwd, "a.txt"), "agent-change\n");
	writeFileSync(join(workspace.cwd, "new-by-agent.txt"), "new\n");
	const result = captureWorkspaceResult(workspace);
	check("workspace patch contains only post-baseline agent change", result.patch.includes("agent-change") && result.patch.includes("user-dirty-baseline"));
	check("workspace result includes newly created file", result.changedFiles.includes("new-by-agent.txt"));
	check("source checkout remains untouched by agent change", readFileSync(join(source, "a.txt"), "utf8") === "user-dirty-baseline\n");
	removeIsolatedWorkspace(workspace);
	check("isolated worktree can be explicitly removed", !existsSync(workspace.worktreeRoot));
}

// ---- Time banner (wall-clock awareness) ------------------------------------
console.log("Time banner — formatWeaNow / withCurrentTime");
{
	const fixed = new Date(2026, 6, 14, 22, 15, 30); // local wall time
	const iso = formatWeaNow(fixed);
	check(
		"formatWeaNow matches ISO-8601 with offset",
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(iso),
	);
	check("formatWeaNow uses local Y-M-D H:M:S of given Date", iso.startsWith("2026-07-14T22:15:30"));
	const wrapped = withCurrentTime("BODY");
	check("withCurrentTime starts with [Current time: prefix", wrapped.startsWith("[Current time:"));
	check("withCurrentTime retains body", wrapped.includes("BODY"));
	const wrappedFixed = withCurrentTime("BODY", fixed);
	check(
		"withCurrentTime embeds formatWeaNow",
		wrappedFixed === `[Current time: ${iso}]\n\nBODY`,
	);
}

console.log("");
if (failures > 0) {
	console.error(`SELF-TEST FAILED: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("SELF-TEST PASSED — Phases 3–5 + correctness regressions all green (offline).");
