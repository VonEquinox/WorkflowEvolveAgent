/**
 * wea run — Phase 1 CLI entry. Drives one WorkflowInstance to completion:
 *   load template graph + agent cards → seal graph → event loop
 *   (ready → spawn AgentSession per node, in parallel up to max) → on finish,
 *   feed scheduler → repeat until terminal → export both trace surfaces.
 *
 * Usage:
 *   WEA_BASE_URL=.. WEA_API_KEY=.. WEA_MODEL=.. \
 *     tsx src/run.ts --task "..." --template t2-bugfix [--repo <dir>] [--out <dir>]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BudgetLedger } from "./budget.ts";
import { GraphScheduler } from "./graph.ts";
import { loadTemplate } from "./library.ts";
import { runNode, SessionFactory } from "./node-session.ts";
import { buildComplianceTrace, buildPvfTrace, newTraceId, type RunManifest } from "./trace-export.ts";
import type { NodeRunRecord, RunBudget } from "./types.ts";

interface CliArgs {
	task: string;
	template: string;
	repo: string;
	out: string;
	maxParallel: number;
}

function parseArgs(argv: string[]): CliArgs {
	const get = (flag: string, dflt?: string): string => {
		const i = argv.indexOf(flag);
		if (i >= 0 && i + 1 < argv.length) return argv[i + 1]!;
		if (dflt !== undefined) return dflt;
		throw new Error(`missing required ${flag}`);
	};
	return {
		task: get("--task"),
		template: get("--template"),
		repo: resolve(get("--repo", process.cwd())),
		out: resolve(get("--out", join(process.cwd(), "runs"))),
		maxParallel: Number(get("--max-parallel", "3")),
	};
}

const DEFAULT_BUDGET: RunBudget = {
	wallTimeMs: 15 * 60_000, // proxy endpoint is slow (FINDINGS §3.4)
	modelTokens: 500_000,
	monetaryMicrounits: 5_000_000, // $5
};

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const { baseUrl, apiKey, modelId } = requireEnv();

	const { graph, cards, templateVersion } = loadTemplate(args.template);
	const factory = new SessionFactory({ baseUrl, apiKey, modelId });
	const ledger = new BudgetLedger(DEFAULT_BUDGET);
	const scheduler = new GraphScheduler(graph);

	const runId = crypto.randomUUID();
	const traceId = newTraceId();
	const startedAt = new Date().toISOString();
	const records: NodeRunRecord[] = [];

	scheduler.sealAll();
	log(`sealed ${graph.nodes.length} nodes; starting event loop`);

	const inFlight = new Map<string, Promise<NodeRunRecord>>();
	const retriesUsed = new Map<string, number>();
	const MAX_NODE_RETRIES = 1; // one bounded retry per node per run (D14)

	while (!scheduler.allTerminal()) {
		// Spawn every ready node up to the parallelism cap.
		for (const nodeId of scheduler.readyNodes()) {
			if (inFlight.size >= args.maxParallel) break;
			if (inFlight.has(nodeId)) continue;
			if (ledger.exceeded()) {
				scheduler.reportFailure(nodeId, "BUDGET_EXCEEDED", "run budget exhausted before spawn");
				continue;
			}
			const node = scheduler.nodes.get(nodeId)!;
			const card = cards.get(node.agentCard);
			if (!card) throw new Error(`node ${nodeId} references unknown agent card ${node.agentCard}`);
			const rt = scheduler.runtime.get(nodeId)!;
			scheduler.markRunning(nodeId);
			const taskPrompt = renderPrompt(node.promptTemplate, args.task, upstreamOutputs(nodeId, graph, records));
			log(`▶ ${nodeId} (attempt ${scheduler.attemptNo(nodeId)}) card=${card.name}`);
			inFlight.set(
				nodeId,
				runNode({
					nodeId,
					attemptNo: scheduler.attemptNo(nodeId),
					kind: node.kind,
					card,
					taskPrompt,
					cwd: args.repo,
					repoRoot: args.repo,
					factory,
					ledger,
					timing: { plannedAt: rt.plannedAt, readyAt: rt.readyAt ?? rt.plannedAt },
					modelOverride: node.model,
				}),
			);
		}

		if (inFlight.size === 0) {
			if (scheduler.stalled()) {
				log("scheduler stalled with no runnable nodes; stopping");
				break;
			}
			continue;
		}

		// Wait for the next node to finish, feed the scheduler, loop.
		const [nodeId, record] = await race(inFlight);
		inFlight.delete(nodeId);
		records.push(record);
		if (record.status === "success") {
			log(`✔ ${nodeId} ok  tokens=${sumTokens(record)} tools=${record.toolCalls.length}`);
			scheduler.reportSuccess(nodeId, record.output);
		} else {
			const used = retriesUsed.get(nodeId) ?? 0;
			if (record.error?.retryable && used < MAX_NODE_RETRIES && !ledger.exceeded()) {
				retriesUsed.set(nodeId, used + 1);
				log(`↻ ${nodeId} ${record.error.code}; bounded retry (${used + 1}/${MAX_NODE_RETRIES})`);
				scheduler.retryNode(nodeId);
			} else {
				log(`✘ ${nodeId} ${record.error?.code}: ${record.error?.message}`);
				scheduler.reportFailure(nodeId, record.error?.code ?? "UNKNOWN", record.error?.message ?? "node failed");
			}
		}
	}

	const endedAt = new Date().toISOString();
	const status = computeRunStatus(records, graph, scheduler.allTerminal());

	const manifest: RunManifest = {
		runId,
		traceId,
		task: args.task,
		templateId: args.template,
		templateVersion,
		graph,
		records,
		schedulerEvents: scheduler.events,
		budget: DEFAULT_BUDGET,
		startedAt,
		endedAt,
		status,
		repoRoot: args.repo,
		modelId,
		piVersion: "0.80.6",
	};

	mkdirSync(args.out, { recursive: true });
	const base = join(args.out, `${args.template}-${runId.slice(0, 8)}`);
	writeFileSync(`${base}.trace.json`, JSON.stringify(buildComplianceTrace(manifest), null, 2));
	writeFileSync(`${base}.pvf.json`, JSON.stringify(buildPvfTrace(manifest), null, 2));
	writeFileSync(`${base}.manifest.json`, JSON.stringify(manifest, null, 2));

	const snap = ledger.snapshot();
	log(`\ndone status=${status}`);
	log(`tokens=${snap.tokensUsed}/${DEFAULT_BUDGET.modelTokens}  cost=$${(snap.monetaryMicrounitsUsed / 1e6).toFixed(4)}`);
	log(`wrote ${base}.{trace,pvf,manifest}.json`);
	log(`validate:  python3 tools/validate_ir.py ${base}.trace.json`);
	log(`attribute: python3 prototypes/attribution.py ${base}.pvf.json --pretty`);
}

// ---- helpers ----------------------------------------------------------------

function requireEnv(): { baseUrl: string; apiKey: string; modelId: string } {
	const baseUrl = process.env.WEA_BASE_URL;
	const apiKey = process.env.WEA_API_KEY;
	const modelId = process.env.WEA_MODEL;
	if (!baseUrl || !apiKey || !modelId) throw new Error("set WEA_BASE_URL / WEA_API_KEY / WEA_MODEL");
	return { baseUrl, apiKey, modelId };
}

/**
 * Outputs of this node's graph predecessors (latest successful attempt per
 * producer). MUST mirror trace-export.executedPredecessors: what goes into the
 * prompt is exactly what the trace declares as consumed (input_bindings).
 */
function upstreamOutputs(nodeId: string, graph: RunManifest["graph"], records: NodeRunRecord[]): NodeRunRecord[] {
	const producers = graph.edges
		.filter((e) => e.to === nodeId && e.kind !== "FEEDBACK" && e.from !== "@input")
		.map((e) => e.from);
	const picked: NodeRunRecord[] = [];
	for (const producer of producers) {
		const latest = records
			.filter((r) => r.nodeId === producer && r.status === "success" && r.output)
			.sort((a, b) => (a.endedAt < b.endedAt ? -1 : 1))
			.at(-1);
		if (latest) picked.push(latest);
	}
	return picked;
}

/** Substitute ${task} and ${upstream} (this node's consumed predecessor outputs). */
function renderPrompt(template: string, task: string, upstream: NodeRunRecord[]): string {
	const upstreamText = upstream
		.map((r) => `### From ${r.nodeId}:\n${JSON.stringify(r.output, null, 2)}`)
		.join("\n\n");
	return template
		.replaceAll("${task}", task)
		.replaceAll("${upstream}", upstreamText || "(no upstream output yet)");
}

async function race(inFlight: Map<string, Promise<NodeRunRecord>>): Promise<[string, NodeRunRecord]> {
	return Promise.race(
		[...inFlight.entries()].map(async ([id, p]): Promise<[string, NodeRunRecord]> => [id, await p]),
	);
}

/**
 * Run success = every @output-feeding node's LAST attempt succeeded AND, when
 * that node emits a verdict (verifier), the verdict is "pass". A verifier whose
 * session succeeded but reported verdict:"fail" (fix loop exhausted) is a
 * failed RUN, not a failed session.
 */
function computeRunStatus(
	records: NodeRunRecord[],
	graph: RunManifest["graph"],
	allTerminal: boolean,
): "success" | "failure" {
	if (!allTerminal) return "failure";
	const outputNodes = graph.edges.filter((e) => e.to === "@output").map((e) => e.from);
	for (const nodeId of outputNodes) {
		const last = records
			.filter((r) => r.nodeId === nodeId)
			.sort((a, b) => a.attemptNo - b.attemptNo)
			.at(-1);
		if (!last || last.status !== "success") return "failure";
		const verdict = (last.output as Record<string, unknown> | null)?.verdict;
		if (verdict !== undefined && verdict !== "pass") return "failure";
	}
	return "success";
}

const sumTokens = (r: NodeRunRecord): number => r.usage.reduce((a, u) => a + u.total, 0);
const log = (msg: string): void => console.log(msg);

main().catch((err) => {
	console.error("RUN FAILED:", err);
	process.exit(1);
});
