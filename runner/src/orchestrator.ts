/**
 * Orchestrator — the runner's execution loop as a reusable, event-emitting
 * function. Both frontends drive it:
 *   - the CLI (run.ts) forwards events to console lines;
 *   - the GUI server (gui-server.ts) forwards events to the browser over SSE.
 *
 * Two modes:
 *   - "live": WEA control plane (WEA_*) plans/adapts the graph; worker nodes
 *     run as pi AgentSessions on the user's **default pi model**;
 *   - "sim":  the SAME GraphScheduler drives the SAME event pipeline, but node
 *     execution is a deterministic no-network stub — so the GUI (and tests) can
 *     exercise scheduling, parallelism, activities and progress with zero spend.
 *     Sim runs write no trace files.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetLedger } from "./budget.ts";
import { GraphScheduler } from "./graph.ts";
import { loadAgentCards, loadTemplate } from "./library.ts";
import { currentChampion } from "./champion.ts";
import { runNode, PiWorkerFactory, type AgentCard } from "./node-session.ts";
import { planWorkflow, type PlanResult } from "./plan.ts";
import type { RecorderActivity } from "./recorder-ext.ts";
import { retrieve, type TaskCard } from "./retrieval.ts";
import { buildComplianceTrace, buildPvfTrace, newTraceId, type RunManifest } from "./trace-export.ts";
import type { NodeOutput, NodeRunRecord, RunBudget, WorkflowGraph } from "./types.ts";
import { loadWeaControlConfig, type WeaControlConfig } from "./wea-control.ts";

// ---- events -------------------------------------------------------------------

export type RunEvent =
	| { type: "template_resolved"; templateRef: string; why: string; planMode?: string }
	| {
			type: "run_started";
			runId: string;
			task: string;
			templateRef: string;
			templateVersion: string;
			mode: RunMode;
			graph: WorkflowGraph;
			cards: Record<string, { name: string; description: string; tools: string[] }>;
			workerModel?: string;
			controlModel?: string;
	  }
	| { type: "node_state"; nodeId: string; state: string; attemptNo: number; detail?: string }
	| { type: "loop"; loopId: string; iteration: number; exhausted: boolean }
	| { type: "node_activity"; nodeId: string; attemptNo: number; activity: RecorderActivity }
	| { type: "node_result"; nodeId: string; attemptNo: number; status: string; summary: string; tokens: number; costMicrounits: number; toolCalls: number; output: NodeOutput | null; error: string | null }
	| { type: "budget"; tokensUsed: number; costMicrounits: number }
	| { type: "log"; message: string }
	| { type: "run_done"; status: "success" | "failure"; tokens: number; costMicrounits: number; files: string[] };

export type RunMode = "live" | "sim";

export interface ExecuteOptions {
	task: string;
	/** template id, versioned ref, or "auto" (control plan: retrieve → adapt / cold-start). */
	templateRef: string;
	family?: string;
	language?: string;
	repo: string;
	/** live mode: where trace files go. */
	out?: string;
	maxParallel?: number;
	mode: RunMode;
	/**
	 * WEA control-plane credentials (plan / adapt / cold-start).
	 * Worker nodes do NOT use this — they use the default pi model.
	 * If omitted in live mode, loaded from WEA_* env; if still missing, auto
	 * planning falls back to offline retrieval (no adapt/cold-start).
	 */
	control?: WeaControlConfig | null;
	/** @deprecated use `control` — accepted for older callers */
	env?: { baseUrl: string; apiKey: string; modelId: string };
	/** Skip control-plane LLM even if configured (tests / offline). */
	offlinePlan?: boolean;
	/** Persist adapted / cold-start templates under library/templates. Default true. */
	persistPlan?: boolean;
	budget?: RunBudget;
	onEvent?: (e: RunEvent) => void;
}

export interface ExecuteResult {
	runId: string;
	status: "success" | "failure";
	templateRef: string;
	tokens: number;
	costMicrounits: number;
	/** written trace files (live mode only). */
	files: string[];
	plan?: PlanResult;
}

const DEFAULT_BUDGET: RunBudget = {
	wallTimeMs: 15 * 60_000,
	modelTokens: 500_000,
	monetaryMicrounits: 5_000_000,
};

// ---- template resolution (legacy helper: retrieval + champion alias) ------------

/** Offline-only resolver (no control LLM). Kept for GUI early validation. */
export function resolveTemplateRef(opts: Pick<ExecuteOptions, "task" | "templateRef" | "family" | "language">): {
	ref: string;
	why: string;
} {
	if (opts.templateRef !== "auto") return { ref: opts.templateRef, why: "explicitly requested" };
	const card: TaskCard = { goal: opts.task, family: opts.family, language: opts.language, hasOracle: true };
	const ranked = retrieve(card);
	const chosen = ranked[0]!;
	const champ = currentChampion(chosen.id);
	if (champ !== chosen.id) {
		return { ref: champ, why: `retrieval → ${chosen.id} (score ${chosen.score.toFixed(2)}) → champion ${champ}` };
	}
	return { ref: chosen.id, why: `retrieval → ${chosen.id} (score ${chosen.score.toFixed(2)}; ${chosen.why.join("; ") || "fallback"})` };
}

function controlFromOpts(opts: ExecuteOptions): WeaControlConfig | null {
	if (opts.control === null) return null;
	if (opts.control) return opts.control;
	if (opts.env) {
		return { baseUrl: opts.env.baseUrl, apiKey: opts.env.apiKey, modelId: opts.env.modelId };
	}
	return loadWeaControlConfig();
}

// ---- sim node execution ----------------------------------------------------------

const SIM_SCRIPTS: Record<string, { tool: string; detail: string }[]> = {
	planner: [
		{ tool: "ls", detail: "." },
		{ tool: "grep", detail: "TODO|FIXME" },
		{ tool: "read", detail: "src/main.ts" },
	],
	worker: [
		{ tool: "read", detail: "src/main.ts" },
		{ tool: "edit", detail: "src/main.ts" },
		{ tool: "bash", detail: "npm test" },
	],
	verifier: [
		{ tool: "read", detail: "src/main.ts" },
		{ tool: "bash", detail: "npm test" },
	],
	aggregator: [{ tool: "read", detail: "proposals (upstream)" }],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic pseudo-random (per node) so sim runs are stable. */
function seeded(seedText: string): () => number {
	let s = 0;
	for (const ch of seedText) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0xffffffff;
	};
}

async function runNodeSim(args: {
	nodeId: string;
	attemptNo: number;
	kind: NodeRunRecord["kind"];
	cardName: string;
	ledger: BudgetLedger;
	plannedAt: string;
	readyAt: string;
	onActivity?: (a: RecorderActivity) => void;
}): Promise<NodeRunRecord> {
	const rnd = seeded(`${args.nodeId}#${args.attemptNo}`);
	const startedAt = new Date().toISOString();
	const script = SIM_SCRIPTS[args.kind] ?? SIM_SCRIPTS.worker!;
	let toolCalls = 0;
	for (const step of script) {
		await sleep(250 + Math.floor(rnd() * 450));
		args.onActivity?.({ kind: "tool_call", tool: step.tool, detail: step.detail });
		await sleep(120 + Math.floor(rnd() * 200));
		args.onActivity?.({ kind: "tool_result", tool: step.tool, isError: false, chars: 200 + Math.floor(rnd() * 4000) });
		toolCalls += 1;
	}
	await sleep(200 + Math.floor(rnd() * 300));
	const input = 800 + Math.floor(rnd() * 1200);
	const output = 200 + Math.floor(rnd() * 400);
	const costMicrounits = Math.round((input * 2 + output * 10) * 1.0);
	args.onActivity?.({ kind: "llm", inputTokens: input, outputTokens: output, costMicrounits });
	args.ledger.charge({ input, output, cachedInput: 0, total: input + output, costMicrounits });

	const out: NodeOutput =
		args.kind === "verifier"
			? { summary: `verified ${args.nodeId} (sim)`, verdict: "pass", checks: [{ name: "tests", result: "pass" }] }
			: { summary: `${args.nodeId} done (sim attempt ${args.attemptNo})` };
	const endedAt = new Date().toISOString();
	return {
		nodeId: args.nodeId,
		attemptNo: args.attemptNo,
		agentCard: args.cardName,
		kind: args.kind,
		sessionId: `sim-${args.nodeId}-${args.attemptNo}`,
		systemPromptDigest: "sha256:" + "0".repeat(64),
		toolCalls: Array.from({ length: toolCalls }, (_, i) => ({ tool: script[i]!.tool, toolCallId: `sim-${i}`, input: {} })),
		toolResults: [],
		usage: [{ input, output, cachedInput: 0, total: input + output, costMicrounits }],
		finalText: JSON.stringify(out),
		output: out,
		status: "success",
		error: null,
		plannedAt: args.plannedAt,
		readyAt: args.readyAt,
		startedAt,
		endedAt,
		readSet: [],
		writeSet: [],
		observations: [],
		usedBash: script.some((s) => s.tool === "bash"),
		redactions: 0,
	};
}

// ---- the loop --------------------------------------------------------------------

export async function executeRun(opts: ExecuteOptions): Promise<ExecuteResult> {
	const emit = (e: RunEvent) => opts.onEvent?.(e);
	const maxParallel = opts.maxParallel ?? 3;
	const budget = opts.budget ?? DEFAULT_BUDGET;
	const control = controlFromOpts(opts);

	// ---- plan: retrieve → (control) adapt | cold_start | use -----------------
	const plan = await planWorkflow({
		task: opts.task,
		family: opts.family,
		language: opts.language,
		explicitTemplate: opts.templateRef === "auto" ? undefined : opts.templateRef,
		control: opts.mode === "live" && !opts.offlinePlan ? control : null,
		offline: opts.mode === "sim" || opts.offlinePlan === true || !control,
		persist: opts.persistPlan !== false && opts.mode === "live",
		onLog: (message) => emit({ type: "log", message }),
	});

	let graph: WorkflowGraph;
	let cards: Map<string, AgentCard>;
	let templateVersion: string;
	let templateRef: string;

	if (plan.mode === "explicit" && opts.templateRef !== "auto") {
		// load from disk (supports versioned refs / champion aliases)
		const resolved = resolveTemplateRef(opts);
		templateRef = resolved.ref;
		const loaded = loadTemplate(templateRef);
		graph = loaded.graph;
		cards = loaded.cards;
		templateVersion = loaded.templateVersion;
		emit({ type: "template_resolved", templateRef, why: resolved.why, planMode: "explicit" });
	} else if (plan.mode === "adapt" || plan.mode === "cold_start") {
		// cold-start writes base file `${id}.json`; adapt writes versioned challenger.
		if (plan.mode === "cold_start") templateRef = plan.baseId;
		else if (plan.writtenPath) templateRef = `${plan.baseId}@${plan.version}`;
		else templateRef = plan.baseId;
		graph = plan.graph;
		templateVersion = plan.version;
		cards = loadAgentCards();
		for (const n of graph.nodes) {
			if (!cards.has(n.agentCard)) {
				throw new Error(`planned graph node ${n.id} needs missing card ${n.agentCard}`);
			}
		}
		emit({ type: "template_resolved", templateRef, why: plan.why, planMode: plan.mode });
	} else {
		// use / offline retrieval — honour champion alias when base id
		const champ = currentChampion(plan.baseId);
		templateRef = champ !== plan.baseId ? champ : plan.baseId;
		if (templateRef.includes("@") || champ !== plan.baseId) {
			const loaded = loadTemplate(templateRef);
			graph = loaded.graph;
			cards = loaded.cards;
			templateVersion = loaded.templateVersion;
		} else {
			graph = plan.graph;
			templateVersion = plan.version;
			cards = loadAgentCards();
		}
		emit({ type: "template_resolved", templateRef, why: plan.why, planMode: plan.mode });
	}

	// Workers never inherit control-plane model ids from graph nodes.
	for (const n of graph.nodes) delete n.model;

	const ledger = new BudgetLedger(budget);
	const scheduler = new GraphScheduler(graph);

	let factory: PiWorkerFactory | null = null;
	let workerModelLabel: string | undefined;
	if (opts.mode === "live") {
		factory = new PiWorkerFactory();
		workerModelLabel = factory.modelLabel;
		emit({ type: "log", message: `worker model (pi default): ${workerModelLabel}` });
		if (control) {
			emit({ type: "log", message: `control model (WEA): ${control.modelId} @ ${control.baseUrl}` });
		} else {
			emit({ type: "log", message: "control model (WEA): offline / not configured — retrieval only" });
		}
	}

	const runId = crypto.randomUUID();
	const traceId = newTraceId();
	const startedAt = new Date().toISOString();
	const records: NodeRunRecord[] = [];

	emit({
		type: "run_started",
		runId,
		task: opts.task,
		templateRef,
		templateVersion,
		mode: opts.mode,
		graph,
		cards: Object.fromEntries(
			[...cards.entries()].map(([name, c]: [string, AgentCard]) => [
				name,
				{ name: c.name, description: c.description, tools: c.tools ?? ["(defaults)"] },
			]),
		),
		workerModel: workerModelLabel,
		controlModel: control?.modelId,
	});

	scheduler.sealAll();
	let flushedEvents = 0;
	const flushSchedulerEvents = () => {
		for (; flushedEvents < scheduler.events.length; flushedEvents++) {
			const ev = scheduler.events[flushedEvents]!;
			if (ev.type === "LOOP_ITERATION" || ev.type === "LOOP_EXHAUSTED") {
				emit({ type: "loop", loopId: ev.loopId!, iteration: ev.iteration ?? 0, exhausted: ev.type === "LOOP_EXHAUSTED" });
			} else if (ev.nodeId) {
				const rt = scheduler.runtime.get(ev.nodeId);
				emit({
					type: "node_state",
					nodeId: ev.nodeId,
					state: rt?.state ?? "?",
					attemptNo: rt?.attemptNo ?? 1,
					detail: ev.detail,
				});
			}
		}
	};
	flushSchedulerEvents();

	const inFlight = new Map<string, Promise<NodeRunRecord>>();
	const retriesUsed = new Map<string, number>();
	const MAX_NODE_RETRIES = 1;

	while (!scheduler.allTerminal()) {
		for (const nodeId of scheduler.readyNodes()) {
			if (inFlight.size >= maxParallel) break;
			if (inFlight.has(nodeId)) continue;
			if (ledger.exceeded()) {
				scheduler.reportFailure(nodeId, "BUDGET_EXCEEDED", "run budget exhausted before spawn");
				flushSchedulerEvents();
				continue;
			}
			const node = scheduler.nodes.get(nodeId)!;
			const card = cards.get(node.agentCard);
			if (!card) throw new Error(`node ${nodeId} references unknown agent card ${node.agentCard}`);
			const rt = scheduler.runtime.get(nodeId)!;
			const attemptNo = scheduler.attemptNo(nodeId);
			scheduler.markRunning(nodeId);
			flushSchedulerEvents();
			const onActivity = (a: RecorderActivity) => emit({ type: "node_activity", nodeId, attemptNo, activity: a });
			const taskPrompt = renderPrompt(node.promptTemplate, opts.task, upstreamOutputs(nodeId, graph, records));
			emit({ type: "log", message: `▶ ${nodeId} (attempt ${attemptNo}) card=${card.name}` });

			const promise =
				opts.mode === "sim"
					? runNodeSim({
							nodeId,
							attemptNo,
							kind: node.kind,
							cardName: card.name,
							ledger,
							plannedAt: rt.plannedAt,
							readyAt: rt.readyAt ?? rt.plannedAt,
							onActivity,
						})
					: runNode({
							nodeId,
							attemptNo,
							kind: node.kind,
							card,
							taskPrompt,
							cwd: opts.repo,
							repoRoot: opts.repo,
							factory: factory!,
							ledger,
							timing: { plannedAt: rt.plannedAt, readyAt: rt.readyAt ?? rt.plannedAt },
							onActivity,
						});
			inFlight.set(nodeId, promise);
		}

		if (inFlight.size === 0) {
			if (scheduler.stalled()) {
				emit({ type: "log", message: "scheduler stalled with no runnable nodes; stopping" });
				break;
			}
			await sleep(5);
			continue;
		}

		const [nodeId, record] = await race(inFlight);
		inFlight.delete(nodeId);
		records.push(record);
		const tokens = record.usage.reduce((a, u) => a + u.input + u.output, 0);
		const cost = record.usage.reduce((a, u) => a + u.costMicrounits, 0);
		emit({
			type: "node_result",
			nodeId,
			attemptNo: record.attemptNo,
			status: record.status,
			summary: record.output?.summary ?? record.error?.message ?? "",
			tokens,
			costMicrounits: cost,
			toolCalls: record.toolCalls.length,
			output: record.output,
			error: record.error ? `${record.error.code}: ${record.error.message}` : null,
		});
		const snap = ledger.snapshot();
		emit({ type: "budget", tokensUsed: snap.tokensUsed, costMicrounits: snap.monetaryMicrounitsUsed });

		if (record.status === "success") {
			scheduler.reportSuccess(nodeId, record.output);
		} else {
			const used = retriesUsed.get(nodeId) ?? 0;
			if (record.error?.retryable && used < MAX_NODE_RETRIES && !ledger.exceeded()) {
				retriesUsed.set(nodeId, used + 1);
				emit({ type: "log", message: `↻ ${nodeId} ${record.error.code}; bounded retry (${used + 1}/${MAX_NODE_RETRIES})` });
				scheduler.retryNode(nodeId);
			} else {
				scheduler.reportFailure(nodeId, record.error?.code ?? "UNKNOWN", record.error?.message ?? "node failed");
			}
		}
		flushSchedulerEvents();
	}

	const endedAt = new Date().toISOString();
	const status = computeRunStatus(records, graph, scheduler.allTerminal());

	// Charge control-plane tokens into the ledger snapshot display (best-effort).
	const controlTokens = (plan.controlUsage?.inputTokens ?? 0) + (plan.controlUsage?.outputTokens ?? 0);
	if (controlTokens > 0) {
		ledger.charge({
			input: plan.controlUsage.inputTokens,
			output: plan.controlUsage.outputTokens,
			cachedInput: 0,
			total: controlTokens,
			costMicrounits: 0,
		});
	}
	const snapFinal = ledger.snapshot();

	const files: string[] = [];
	if (opts.mode === "live" && opts.out) {
		const manifest: RunManifest = {
			runId,
			traceId,
			task: opts.task,
			templateId: templateRef,
			templateVersion,
			graph,
			records,
			schedulerEvents: scheduler.events,
			budget,
			startedAt,
			endedAt,
			status,
			repoRoot: opts.repo,
			modelId: workerModelLabel ?? control?.modelId ?? "pi-default",
			piVersion: "0.80.6",
		};
		mkdirSync(opts.out, { recursive: true });
		const safeRef = templateRef.replace(/[^a-zA-Z0-9._@-]+/g, "_");
		const base = join(opts.out, `${safeRef}-${runId.slice(0, 8)}`);
		writeFileSync(`${base}.trace.json`, JSON.stringify(buildComplianceTrace(manifest), null, 2));
		writeFileSync(`${base}.pvf.json`, JSON.stringify(buildPvfTrace(manifest), null, 2));
		writeFileSync(
			`${base}.manifest.json`,
			JSON.stringify(
				{
					...manifest,
					plan: {
						mode: plan.mode,
						why: plan.why,
						baseId: plan.baseId,
						version: plan.version,
						writtenPath: plan.writtenPath,
						controlUsage: plan.controlUsage,
						controlModel: control?.modelId,
						workerModel: workerModelLabel,
					},
				},
				null,
				2,
			),
		);
		files.push(`${base}.trace.json`, `${base}.pvf.json`, `${base}.manifest.json`);
	}

	emit({
		type: "run_done",
		status,
		tokens: snapFinal.tokensUsed,
		costMicrounits: snapFinal.monetaryMicrounitsUsed,
		files,
	});
	return {
		runId,
		status,
		templateRef,
		tokens: snapFinal.tokensUsed,
		costMicrounits: snapFinal.monetaryMicrounitsUsed,
		files,
		plan,
	};
}

// ---- shared helpers (moved from run.ts) -------------------------------------------

export function upstreamOutputs(nodeId: string, graph: WorkflowGraph, records: NodeRunRecord[]): NodeRunRecord[] {
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

export function renderPrompt(template: string, task: string, upstream: NodeRunRecord[]): string {
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

export function computeRunStatus(
	records: NodeRunRecord[],
	graph: WorkflowGraph,
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
