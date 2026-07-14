/**
 * Offline smoke test for the two trace exporters — no network, no API spend.
 * Builds a synthetic RunManifest that mimics a T1 run with one fix-loop pass,
 * writes both trace surfaces, and prints the paths so the caller can pipe them
 * through tools/validate_ir.py and prototypes/attribution.py.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildComplianceTrace, buildPvfTrace, newTraceId, type RunManifest } from "./trace-export.ts";
import type { NodeOutput, NodeRunRecord, UsageSample, WorkflowGraph } from "./types.ts";

const usage = (input: number, output: number, costMicro: number): UsageSample => ({
	input,
	output,
	cachedInput: 0,
	total: input + output,
	costMicrounits: costMicro,
});

function record(
	nodeId: string,
	kind: NodeRunRecord["kind"],
	attemptNo: number,
	t0: number,
	durMs: number,
	output: NodeOutput,
	reads: string[] = [],
	writes: string[] = [],
): NodeRunRecord {
	const startedAt = new Date(t0).toISOString();
	const endedAt = new Date(t0 + durMs).toISOString();
	return {
		nodeId,
		attemptNo,
		agentCard: kind,
		kind,
		sessionId: `sess-${nodeId}-${attemptNo}`,
		systemPromptDigest: "sha256:" + "a".repeat(64),
		toolCalls: reads.map((p, i) => ({ tool: "read", toolCallId: `tc-${nodeId}-${i}`, input: { path: p } })),
		toolResults: [],
		usage: [usage(1000 + attemptNo * 10, 300, 5000)],
		finalText: JSON.stringify(output),
		output,
		status: "success",
		error: null,
		plannedAt: startedAt,
		readyAt: startedAt,
		startedAt,
		endedAt,
		readSet: reads,
		writeSet: writes,
		observations: [],
		usedBash: false,
		redactions: 0,
	};
}

const graph: WorkflowGraph = {
	nodes: [
		{ id: "inspect", kind: "planner", agentCard: "inspector", trigger: "ALL_SUCCESS", promptTemplate: "" },
		{ id: "implement", kind: "worker", agentCard: "implementer", trigger: "ALL_SUCCESS", promptTemplate: "" },
		{ id: "verify", kind: "verifier", agentCard: "verifier", trigger: "ALL_SUCCESS", promptTemplate: "" },
	],
	edges: [
		{ id: "e_in", from: "@input", to: "inspect", kind: "DATA" },
		{ id: "e_iv", from: "inspect", to: "implement", kind: "DATA" },
		{ id: "e_ivf", from: "implement", to: "verify", kind: "DATA" },
		{ id: "e_out", from: "verify", to: "@output", kind: "DATA" },
		{ id: "e_loop", from: "verify", to: "implement", kind: "FEEDBACK", loopId: "fix" },
	],
	loops: [{ id: "fix", bodyNodes: ["implement", "verify"], feedbackEdges: ["e_loop"], maxIterations: 2 }],
};

const T = 1_700_000_000_000;
const records: NodeRunRecord[] = [
	record("inspect", "planner", 1, T, 2000, { summary: "found it", files_seen: ["a.ts"], subtasks: ["fix x"] }, ["a.ts"]),
	// first pass: verify fails
	record("implement", "worker", 1, T + 2000, 3000, { summary: "patched", files_changed: ["a.ts"] }, ["a.ts"], ["a.ts"]),
	record("verify", "verifier", 1, T + 5000, 2500, { summary: "still broken", verdict: "fail", must_fix: ["edge case"] }, ["a.ts"]),
	// second pass: verify passes
	record("implement", "worker", 2, T + 7500, 3000, { summary: "fixed edge case", files_changed: ["a.ts"] }, ["a.ts"], ["a.ts"]),
	record("verify", "verifier", 2, T + 10500, 2500, { summary: "all good", verdict: "pass", must_fix: [] }, ["a.ts"]),
];

const runId = "00000000-0000-4000-8000-000000000001";
const manifest: RunManifest = {
	runId,
	traceId: newTraceId(),
	task: "fix the off-by-one in a.ts",
	templateId: "t1-safe-generic",
	templateVersion: "1.0.0",
	graph,
	records,
	schedulerEvents: [],
	budget: { wallTimeMs: 900_000, modelTokens: 500_000, monetaryMicrounits: 5_000_000 },
	startedAt: new Date(T).toISOString(),
	endedAt: new Date(T + 13000).toISOString(),
	status: "success",
	repoRoot: process.cwd(),
	modelId: "claude-sub2api-sonnet-5",
	piVersion: "0.80.6",
};

const outDir = join(process.cwd(), "runs", "smoke");
mkdirSync(outDir, { recursive: true });
const traceP = join(outDir, "synthetic.trace.json");
const pvfP = join(outDir, "synthetic.pvf.json");
writeFileSync(traceP, JSON.stringify(buildComplianceTrace(manifest), null, 2));
writeFileSync(pvfP, JSON.stringify(buildPvfTrace(manifest), null, 2));
console.log(traceP);
console.log(pvfP);
