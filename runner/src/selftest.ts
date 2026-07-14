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

import { mkdtempSync } from "node:fs";
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
		plannedAt: "",
		readyAt: "",
		startedAt: "",
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
			{ id: "implement", kind: "worker", agentCard: "implementer", trigger: "ALL_SUCCESS", promptTemplate: "" },
			{ id: "verify", kind: "verifier", agentCard: "verifier", trigger: "ALL_SUCCESS", promptTemplate: "" },
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

	// (b) escalate with replan unavailable → failure not success (detect + terminal code path).
	// Pure helper: detectEscalation must fire; the orchestrator terminal-fail path is
	// covered by ensuring ESCALATE_NO_REPLAN semantics when replan is off — we simulate
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
		nodes: [{ id: "implement", kind: "worker", agentCard: "implementer", trigger: "ALL_SUCCESS", promptTemplate: "" }],
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
			{ id: "implement", kind: "worker", agentCard: "implementer", trigger: "ALL_SUCCESS", promptTemplate: "" },
			{ id: "verify", kind: "verifier", agentCard: "verifier", trigger: "ALL_SUCCESS", promptTemplate: "" },
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

console.log("");
if (failures > 0) {
	console.error(`SELF-TEST FAILED: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("SELF-TEST PASSED — Phases 3–5 + correctness regressions all green (offline).");
