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
import { retrieve } from "./retrieval.ts";
import type { NodeRunRecord } from "./types.ts";

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
		nodeId: "inspect", attemptNo: 1, agentCard: "inspector", kind: "planner",
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

console.log("");
if (failures > 0) {
	console.error(`SELF-TEST FAILED: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("SELF-TEST PASSED — Phases 3, 4, 5 all green (offline).");
