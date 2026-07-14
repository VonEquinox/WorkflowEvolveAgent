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
import {
	detectEscalation,
	isControlHandoffNode,
	masterHandoff,
	masterImprove,
	masterReplan,
	mergeUsage,
	type EscalationSignal,
} from "./master-loop.ts";
import { runNode, PiWorkerFactory, type AgentCard } from "./node-session.ts";
import { planWorkflow, type PlanResult } from "./plan.ts";
import { sha256, type RecorderActivity } from "./recorder-ext.ts";
import { retrieve, type TaskCard } from "./retrieval.ts";
import {
	buildComplianceTrace,
	buildPvfTrace,
	newTraceId,
	repoSnapshotDigest,
	type GraphRevision,
	type RunManifest,
} from "./trace-export.ts";
import type { NodeOutput, NodeRunRecord, RunBudget, WorkflowGraph } from "./types.ts";
import { loadWeaControlConfig, type WeaControlConfig, type ControlUsage } from "./wea-control.ts";
import {
	captureWorkspaceResult,
	prepareIsolatedWorkspace,
	type IsolatedWorkspace,
	type WorkspaceResult,
} from "./workspace.ts";

// ---- events -------------------------------------------------------------------

export type RunEvent =
	| { type: "template_resolved"; templateRef: string; why: string; planMode?: string }
	| {
			type: "plan_detail";
			mode: string;
			baseId: string;
			version: string;
			why: string;
			graph: WorkflowGraph;
			writtenPath?: string;
			controlUsage?: ControlUsage;
			decision?: Record<string, unknown>;
			candidates?: unknown;
	  }
	| {
			type: "run_started";
			runId: string;
			task: string;
			templateRef: string;
			templateVersion: string;
			mode: RunMode;
			graphGeneration: number;
			graph: WorkflowGraph;
			cards: Record<string, { name: string; description: string; tools: string[] }>;
			workerModel?: string;
			controlModel?: string;
	  }
	| { type: "node_state"; nodeId: string; state: string; attemptNo: number; graphGeneration: number; detail?: string }
	| { type: "loop"; loopId: string; iteration: number; exhausted: boolean }
	| { type: "node_activity"; nodeId: string; attemptNo: number; graphGeneration: number; activity: RecorderActivity }
	| { type: "node_result"; nodeId: string; attemptNo: number; graphGeneration: number; status: string; summary: string; tokens: number; costMicrounits: number; toolCalls: number; output: NodeOutput | null; error: string | null }
	| {
			type: "escalation";
			nodeId: string;
			reason: string;
			attemptNo: number;
	  }
	| {
			type: "master_replan";
			ok: boolean;
			why: string;
			graph?: WorkflowGraph;
			templateRef?: string;
	  }
	| {
			type: "master_handoff";
			nodeId: string;
			ok: boolean;
			why: string;
			masterPlan?: string;
			editGraph?: WorkflowGraph;
			templateRef?: string;
	  }
	| {
			type: "master_improve";
			ok: boolean;
			why: string;
			applied: boolean;
			writtenPath?: string;
	  }
	| {
			type: "workspace_prepared";
			sourceRepo: string;
			worktree: string;
			baseCommit: string;
			baselineCommit: string;
			sourceWasDirty: boolean;
	  }
	| {
			type: "workspace_result";
			worktree: string;
			changedFiles: string[];
			patchPath?: string;
			verification: NodeOutput | null;
			note: string;
	  }
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
	/** Optional parent directory for detached per-run worktrees. */
	worktreeBaseDir?: string;
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
	/**
	 * When a worker raises escalate=true, freeze graph, pack context, ask WEA master
	 * for a new graph and re-run. Live + control only. Default true.
	 */
	enableEscalationReplan?: boolean;
	/** Max master replan rounds per executeRun (default 2). */
	maxReplans?: number;
	/**
	 * After the task ends, WEA master reviews the PROCESS and may write an improved
	 * challenger template. Live + control only. Default true.
	 */
	enablePostRunImprove?: boolean;
	/** Persist post-run improve challengers. Default true when improve is enabled. */
	persistImprove?: boolean;
	budget?: RunBudget;
	onEvent?: (e: RunEvent) => void;
}

export interface ExecuteResult {
	runId: string;
	status: "success" | "failure";
	templateRef: string;
	tokens: number;
	costMicrounits: number;
	/** written trace/diff files. */
	files: string[];
	plan?: PlanResult;
	finalOutput?: NodeOutput | null;
	workspace?: {
		sourceRepo: string;
		worktree: string;
		baselineCommit: string;
		changedFiles: string[];
		patchPath?: string;
		verification: NodeOutput | null;
	};
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
	graphGeneration?: number;
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
		graphGeneration: args.graphGeneration ?? 0,
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

function failedNodeRecord(args: {
	nodeId: string;
	attemptNo: number;
	graphGeneration: number;
	kind: NodeRunRecord["kind"];
	card: AgentCard;
	plannedAt: string;
	readyAt: string;
	error: unknown;
	code?: string;
}): NodeRunRecord {
	const at = new Date().toISOString();
	return {
		nodeId: args.nodeId,
		attemptNo: args.attemptNo,
		graphGeneration: args.graphGeneration,
		agentCard: args.card.name,
		kind: args.kind,
		sessionId: `failed-${args.nodeId}-${args.attemptNo}`,
		systemPromptDigest: sha256(args.card.systemPrompt),
		toolCalls: [],
		toolResults: [],
		usage: [],
		finalText: "",
		output: null,
		status: "failure",
		error: {
			code: args.code ?? "NODE_RUNTIME_ERROR",
			message: String((args.error as Error)?.message ?? args.error),
			retryable: false,
		},
		plannedAt: args.plannedAt,
		readyAt: args.readyAt,
		startedAt: at,
		endedAt: at,
		readSet: [],
		writeSet: [],
		observations: [],
		usedBash: false,
		redactions: 0,
	};
}

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
		emit({
			type: "plan_detail",
			mode: "explicit",
			baseId: plan.baseId,
			version: templateVersion,
			why: resolved.why,
			graph,
			controlUsage: plan.controlUsage,
			decision: plan.decision,
		});
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
		emit({
			type: "plan_detail",
			mode: plan.mode,
			baseId: plan.baseId,
			version: plan.version,
			why: plan.why,
			graph,
			writtenPath: plan.writtenPath,
			controlUsage: plan.controlUsage,
			decision: plan.decision,
		});
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
		emit({
			type: "plan_detail",
			mode: plan.mode,
			baseId: plan.baseId,
			version: templateVersion,
			why: plan.why,
			graph,
			writtenPath: plan.writtenPath,
			controlUsage: plan.controlUsage,
			decision: plan.decision,
			candidates: plan.candidates,
		});
	}

	// Workers never inherit control-plane model ids from graph nodes.
	for (const n of graph.nodes) delete n.model;

	const runId = crypto.randomUUID();
	const traceId = newTraceId();
	const startedAt = new Date().toISOString();
	let executionRepo = opts.repo;
	let isolatedWorkspace: IsolatedWorkspace | null = null;
	let workspaceError: Error | null = null;
	if (opts.mode === "live") {
		try {
			isolatedWorkspace = prepareIsolatedWorkspace({
				repo: opts.repo,
				runId,
				worktreeBaseDir: opts.worktreeBaseDir,
			});
			executionRepo = isolatedWorkspace.cwd;
			emit({
				type: "workspace_prepared",
				sourceRepo: isolatedWorkspace.sourceRepoRoot,
				worktree: isolatedWorkspace.worktreeRoot,
				baseCommit: isolatedWorkspace.baseCommit,
				baselineCommit: isolatedWorkspace.baselineCommit,
				sourceWasDirty: isolatedWorkspace.sourceWasDirty,
			});
		} catch (err) {
			workspaceError = err as Error;
			emit({ type: "log", message: `isolated worktree preparation failed: ${workspaceError.message}` });
		}
	}

	const ledger = new BudgetLedger(budget);
	let factory: PiWorkerFactory | null = null;
	let factoryError: Error | null = workspaceError;
	let workerModelLabel: string | undefined;
	if (opts.mode === "live" && !workspaceError) {
		try {
			factory = new PiWorkerFactory();
			workerModelLabel = factory.modelLabel;
			emit({ type: "log", message: `worker model (pi default): ${workerModelLabel}` });
		} catch (err) {
			factoryError = err as Error;
			workerModelLabel = "unavailable";
			emit({ type: "log", message: `worker model unavailable: ${factoryError.message}` });
		}
	}
	if (opts.mode === "live") {
		if (control) {
			emit({ type: "log", message: `control model (WEA): ${control.modelId} @ ${control.baseUrl}` });
		} else {
			emit({ type: "log", message: "control model (WEA): offline / not configured — retrieval only" });
		}
	}
	const records: NodeRunRecord[] = [];
	const escalations: EscalationSignal[] = [];
	let controlUsageAcc: ControlUsage = { ...(plan.controlUsage ?? { inputTokens: 0, outputTokens: 0 }) };
	const maxReplans = opts.maxReplans ?? 2;
	const enableReplan =
		opts.enableEscalationReplan !== false && opts.mode === "live" && !!control;
	const enableImprove =
		opts.enablePostRunImprove !== false && opts.mode === "live" && !!control;
	let replanCount = 0;
	/** Bumped on each replan / handoff edit-graph start so records from prior phases stay scoped. */
	let graphGeneration = 0;
	const graphRevisions: GraphRevision[] = [
		{
			generation: 0,
			templateId: templateRef,
			templateVersion,
			graph: structuredClone(graph),
			reason: "initial",
			startedAt,
		},
	];
	const allSchedulerEvents: Array<import("./graph.ts").SchedulerEvent & { graphGeneration: number }> = [];
	const inputRepoSnapshotDigest = repoSnapshotDigest(executionRepo);

	const cardsPayload = () =>
		Object.fromEntries(
			[...cards.entries()].map(([name, c]: [string, AgentCard]) => [
				name,
				{ name: c.name, description: c.description, tools: c.tools ?? ["(defaults)"] },
			]),
		);

	emit({
		type: "run_started",
		runId,
		task: opts.task,
		templateRef,
		templateVersion,
		mode: opts.mode,
		graphGeneration,
		graph,
		cards: cardsPayload(),
		workerModel: workerModelLabel,
		controlModel: control?.modelId,
	});

	/** Injected by proactive master handoff into subsequent edit-graph prompts. */
	let masterPlanContext = "";

	/** Run one sealed graph to completion (or until escalation / handoff freezes it). */
	async function runGraphOnce(activeGraph: WorkflowGraph): Promise<{
		scheduler: GraphScheduler;
		escalation: EscalationSignal | null;
		handoff: Awaited<ReturnType<typeof masterHandoff>> | null;
	}> {
		const scheduler = new GraphScheduler(activeGraph);
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
						graphGeneration,
						detail: ev.detail,
					});
				}
			}
		};
		flushSchedulerEvents();

		const inFlight = new Map<string, Promise<NodeRunRecord>>();
		const retriesUsed = new Map<string, number>();
		const MAX_NODE_RETRIES = 1;
		let pendingEscalation: EscalationSignal | null = null;
		let pendingHandoff: Awaited<ReturnType<typeof masterHandoff>> | null = null;

		while (!scheduler.allTerminal()) {
			if (pendingEscalation || pendingHandoff) break;

			for (const nodeId of scheduler.readyNodes()) {
				if (pendingEscalation || pendingHandoff) break;
				if (inFlight.size >= maxParallel) break;
				if (inFlight.has(nodeId)) continue;
				if (ledger.exceeded()) {
					scheduler.reportFailure(nodeId, "BUDGET_EXCEEDED", "run budget exhausted before spawn");
					flushSchedulerEvents();
					continue;
				}
				const node = scheduler.nodes.get(nodeId)!;
				const rt = scheduler.runtime.get(nodeId)!;
				const attemptNo = scheduler.attemptNo(nodeId);

				// ---- proactive WEA master handoff (no pi worker) --------------------
				if (isControlHandoffNode(node)) {
					scheduler.markRunning(nodeId);
					flushSchedulerEvents();
					emit({ type: "log", message: `◆ ${nodeId} WEA master handoff (control plane takes over)` });

					// Drain any parallel explorers already in flight before packing context.
					while (inFlight.size > 0) {
						const [id2, rec2] = await race(inFlight);
						inFlight.delete(id2);
						records.push(rec2);
						emit({
							type: "node_result",
							nodeId: id2,
							attemptNo: rec2.attemptNo,
							graphGeneration,
							status: rec2.status,
							summary: rec2.output?.summary ?? rec2.error?.message ?? "",
							tokens: rec2.usage.reduce((a, u) => a + u.input + u.output, 0),
							costMicrounits: rec2.usage.reduce((a, u) => a + u.costMicrounits, 0),
							toolCalls: rec2.toolCalls.length,
							output: rec2.output,
							error: rec2.error ? `${rec2.error.code}: ${rec2.error.message}` : null,
						});
						if (rec2.status === "success") scheduler.reportSuccess(id2, rec2.output);
						else scheduler.reportFailure(id2, rec2.error?.code ?? "UNKNOWN", rec2.error?.message ?? "node failed");
						flushSchedulerEvents();
					}

					const upstream = upstreamOutputs(nodeId, activeGraph, records);
					const startedAt = new Date().toISOString();

					if (opts.mode === "sim" || !control) {
						// Offline stub: synthesize a trivial plan + default edit graph
						const planText = JSON.stringify(
							{
								summary: `sim master plan from ${upstream.map((u) => u.nodeId).join(", ") || "no upstream"}`,
								steps: ["apply explorer consensus", "implement", "verify"],
							},
							null,
							2,
						);
						const { loadTemplate: lt } = await import("./library.ts");
						let editGraph: WorkflowGraph;
						try {
							editGraph = lt("t-implement-verify").graph;
						} catch {
							editGraph = {
								nodes: [
									{
										id: "implement",
										kind: "worker",
										agentCard: "implementer",
										trigger: "ALL_SUCCESS",
										promptTemplate: "${task}\n${master_plan}\n${upstream}",
									},
								],
								edges: [
									{ id: "e1", from: "@input", to: "implement", kind: "DATA" },
									{ id: "e2", from: "implement", to: "@output", kind: "DATA" },
								],
								loops: [],
							};
						}
						const out: NodeOutput = {
							summary: "sim master handoff",
							master_plan: JSON.parse(planText),
							handoff: true,
						};
						const record: NodeRunRecord = {
							nodeId,
							attemptNo,
							graphGeneration,
							agentCard: "master-handoff",
							kind: node.kind,
							sessionId: `handoff-sim-${nodeId}`,
							systemPromptDigest: "sha256:" + "h".repeat(64),
							toolCalls: [],
							toolResults: [],
							usage: [{ input: 0, output: 0, cachedInput: 0, total: 0, costMicrounits: 0 }],
							finalText: JSON.stringify(out),
							output: out,
							status: "success",
							error: null,
							plannedAt: rt.plannedAt,
							readyAt: rt.readyAt ?? rt.plannedAt,
							startedAt,
							endedAt: new Date().toISOString(),
							readSet: [],
							writeSet: [],
							observations: [],
							usedBash: false,
							redactions: 0,
						};
						records.push(record);
						emit({
							type: "node_result",
							nodeId,
							attemptNo,
							graphGeneration,
							status: "success",
							summary: out.summary,
							tokens: 0,
							costMicrounits: 0,
							toolCalls: 0,
							output: out,
							error: null,
						});
						scheduler.reportSuccess(nodeId, out);
						flushSchedulerEvents();
						pendingHandoff = {
							ok: true,
							why: "sim handoff → t-implement-verify",
							masterPlan: planText,
							editGraph,
							baseId: "t-implement-verify",
							version: "1.0.0",
							usage: { inputTokens: 0, outputTokens: 0 },
							output: out,
						};
						emit({
							type: "master_handoff",
							nodeId,
							ok: true,
							why: pendingHandoff.why,
							masterPlan: planText,
							editGraph,
							templateRef: "t-implement-verify",
						});
						break;
					}

					const handoff = await masterHandoff({
						control,
						task: opts.task,
						currentGraph: activeGraph,
						templateRef,
						handoffNodeId: nodeId,
						upstream,
						allRecords: records,
						persist: opts.persistPlan !== false,
						onLog: (message) => emit({ type: "log", message }),
					});
					controlUsageAcc = mergeUsage(controlUsageAcc, handoff.usage);

					const out: NodeOutput = handoff.output ?? {
						summary: handoff.ok ? "master handoff ok" : handoff.why,
						handoff: true,
					};
					const record: NodeRunRecord = {
						nodeId,
						attemptNo,
						graphGeneration,
						agentCard: "master-handoff",
						kind: node.kind,
						sessionId: `handoff-${nodeId}-${attemptNo}`,
						systemPromptDigest: "sha256:" + "c".repeat(64),
						toolCalls: [],
						toolResults: [],
						usage: [
							{
								input: handoff.usage.inputTokens,
								output: handoff.usage.outputTokens,
								cachedInput: 0,
								total: handoff.usage.inputTokens + handoff.usage.outputTokens,
								costMicrounits: 0,
							},
						],
						finalText: JSON.stringify(out),
						output: out,
						status: handoff.ok ? "success" : "failure",
						error: handoff.ok
							? null
							: { code: "HANDOFF_FAILED", message: handoff.why, retryable: false },
						plannedAt: rt.plannedAt,
						readyAt: rt.readyAt ?? rt.plannedAt,
						startedAt,
						endedAt: new Date().toISOString(),
						readSet: [],
						writeSet: [],
						observations: [],
						usedBash: false,
						redactions: 0,
					};
					records.push(record);
					emit({
						type: "node_result",
						nodeId,
						attemptNo,
						graphGeneration,
						status: record.status,
						summary: out.summary ?? handoff.why,
						tokens: handoff.usage.inputTokens + handoff.usage.outputTokens,
						costMicrounits: 0,
						toolCalls: 0,
						output: out,
						error: record.error ? `${record.error.code}: ${record.error.message}` : null,
					});
					emit({
						type: "master_handoff",
						nodeId,
						ok: handoff.ok,
						why: handoff.why,
						masterPlan: handoff.masterPlan,
						editGraph: handoff.editGraph,
						templateRef: handoff.baseId,
					});

					if (handoff.ok && handoff.editGraph) {
						scheduler.reportSuccess(nodeId, out);
						flushSchedulerEvents();
						pendingHandoff = handoff;
					} else {
						scheduler.reportFailure(nodeId, "HANDOFF_FAILED", handoff.why);
						flushSchedulerEvents();
					}
					break;
				}

				// ---- normal pi worker node ------------------------------------------
				const card = cards.get(node.agentCard);
				if (!card) throw new Error(`node ${nodeId} references unknown agent card ${node.agentCard}`);
				scheduler.markRunning(nodeId);
				flushSchedulerEvents();
				const onActivity = (a: RecorderActivity) =>
					emit({ type: "node_activity", nodeId, attemptNo, graphGeneration, activity: a });
				const taskPrompt = renderPrompt(
					node.promptTemplate,
					opts.task,
					upstreamOutputs(nodeId, activeGraph, records, { includeFeedback: attemptNo > 1 }),
					masterPlanContext,
				);
				emit({ type: "log", message: `▶ ${nodeId} (attempt ${attemptNo}) card=${card.name}` });

				const rawPromise =
					opts.mode === "sim"
						? runNodeSim({
								nodeId,
								attemptNo,
								graphGeneration,
								kind: node.kind,
								cardName: card.name,
								ledger,
								plannedAt: rt.plannedAt,
								readyAt: rt.readyAt ?? rt.plannedAt,
								onActivity,
							})
						: factory
							? runNode({
									nodeId,
									attemptNo,
									kind: node.kind,
									card,
									taskPrompt,
									cwd: executionRepo,
									repoRoot: executionRepo,
									factory,
									ledger,
									nodeBudget: node.budget,
									timing: { plannedAt: rt.plannedAt, readyAt: rt.readyAt ?? rt.plannedAt },
									onActivity,
								})
							: Promise.resolve(
									failedNodeRecord({
										nodeId,
										attemptNo,
										graphGeneration,
										kind: node.kind,
										card,
										plannedAt: rt.plannedAt,
										readyAt: rt.readyAt ?? rt.plannedAt,
										error: factoryError ?? new Error("worker factory unavailable"),
										code: "WORKER_FACTORY_ERROR",
									}),
								);
				const promise = rawPromise
					.then((r) => ({ ...r, graphGeneration }))
					.catch((err) =>
						failedNodeRecord({
							nodeId,
							attemptNo,
							graphGeneration,
							kind: node.kind,
							card,
							plannedAt: rt.plannedAt,
							readyAt: rt.readyAt ?? rt.plannedAt,
							error: err,
						}),
					);
				inFlight.set(nodeId, promise);
			}

			if (inFlight.size === 0) {
				if (pendingEscalation || pendingHandoff) break;
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
				graphGeneration,
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

			// Master escalate: worker asked the control plane to replan.
			const esc = detectEscalation(nodeId, record.attemptNo, record.output, record.status);
			if (esc) {
				escalations.push(esc);
				emit({
					type: "escalation",
					nodeId: esc.nodeId,
					reason: esc.reason,
					attemptNo: esc.attemptNo,
				});
				emit({ type: "log", message: `⚠ escalate from ${esc.nodeId}: ${esc.reason}` });

				if (enableReplan && replanCount < maxReplans) {
					// Replan available: freeze graph and hand control to the master loop.
					pendingEscalation = esc;
					scheduler.reportFailure(nodeId, "ESCALATED", esc.reason);
					flushSchedulerEvents();
					// Drain remaining in-flight without starting new work.
					while (inFlight.size > 0) {
						const [id2, rec2] = await race(inFlight);
						inFlight.delete(id2);
						records.push(rec2);
						emit({
							type: "node_result",
							nodeId: id2,
							attemptNo: rec2.attemptNo,
							graphGeneration,
							status: rec2.status,
							summary: rec2.output?.summary ?? rec2.error?.message ?? "",
							tokens: rec2.usage.reduce((a, u) => a + u.input + u.output, 0),
							costMicrounits: rec2.usage.reduce((a, u) => a + u.costMicrounits, 0),
							toolCalls: rec2.toolCalls.length,
							output: rec2.output,
							error: rec2.error ? `${rec2.error.code}: ${rec2.error.message}` : null,
						});
						if (rec2.status === "success") scheduler.reportSuccess(id2, rec2.output);
						else scheduler.reportFailure(id2, rec2.error?.code ?? "UNKNOWN", rec2.error?.message ?? "node failed");
						flushSchedulerEvents();
					}
					break;
				}

				// Replan disabled or exhausted: terminal-fail the node. Never fall through
				// to reportSuccess — that would treat an escalate as a successful run.
				const why =
					!enableReplan
						? `escalate requested but replan disabled: ${esc.reason}`
						: `escalate requested but replan budget exhausted (${replanCount}/${maxReplans}): ${esc.reason}`;
				emit({ type: "log", message: `✗ escalate terminal-fail ${nodeId}: ${why}` });
				// Overwrite the in-memory record so computeRunStatus sees a failure even if
				// the worker's JSON had status:success alongside escalate:true.
				record.status = "failure";
				record.error = { code: "ESCALATE_NO_REPLAN", message: why, retryable: false };
				scheduler.reportFailure(nodeId, "ESCALATE_NO_REPLAN", why);
				flushSchedulerEvents();
				continue;
			}

			if (record.status === "success") {
				scheduler.reportSuccess(nodeId, record.output);
				// handleFeedback may flip SUCCEEDED → FAILED on LOOP_EXHAUSTED; mirror that
				// onto the record so computeRunStatus / @output readiness stay consistent.
				const rtAfter = scheduler.runtime.get(nodeId);
				if (rtAfter?.state === "FAILED" && rtAfter.failure) {
					record.status = "failure";
					record.error = {
						code: rtAfter.failure.code,
						message: rtAfter.failure.message,
						retryable: false,
					};
				}
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

		return { scheduler, escalation: pendingEscalation, handoff: pendingHandoff };
	}

	// ---- outer master loop:
	//   graph run → proactive handoff (edit graph) | escalate replan → re-run ----
	let scheduler = new GraphScheduler(graph); // placeholder until first run
	for (;;) {
		const once = await runGraphOnce(graph);
		scheduler = once.scheduler;
		allSchedulerEvents.push(...once.scheduler.events.map((event) => ({ ...event, graphGeneration })));

		// (A) Proactive handoff: explorers done → WEA planned → dispatch edit graph
		if (once.handoff?.ok && once.handoff.editGraph) {
			masterPlanContext = once.handoff.masterPlan ?? "";
			graphGeneration += 1;
			graph = once.handoff.editGraph;
			for (const n of graph.nodes) delete n.model;
			templateRef = once.handoff.baseId ?? `${templateRef}+edit`;
			templateVersion = once.handoff.version ?? templateVersion;
			graphRevisions.push({
				generation: graphGeneration,
				templateId: templateRef,
				templateVersion,
				graph: structuredClone(graph),
				reason: "master_handoff",
				startedAt: new Date().toISOString(),
			});
			cards = loadAgentCards();
			for (const n of graph.nodes) {
				if (isControlHandoffNode(n)) {
					// never nest handoff inside edit phase
					n.controlHandoff = false;
					n.agentCard = "implementer";
				}
				if (!cards.has(n.agentCard) && !isControlHandoffNode(n)) {
					throw new Error(`edit graph node ${n.id} needs missing card ${n.agentCard}`);
				}
			}
			emit({
				type: "template_resolved",
				templateRef,
				why: once.handoff.why,
				planMode: "master_handoff",
			});
			emit({
				type: "log",
				message: `master handoff → edit graph ${templateRef} (${graph.nodes.length} nodes); master_plan injected`,
			});
			emit({
				type: "run_started",
				runId,
				task: opts.task,
				templateRef,
				templateVersion,
				mode: opts.mode,
				graphGeneration,
				graph,
				cards: cardsPayload(),
				workerModel: workerModelLabel,
				controlModel: control?.modelId,
			});
			// Continue outer loop to execute the edit graph (no second handoff expected).
			continue;
		}

		// (B) Reactive escalate replan
		if (!once.escalation || !control || !enableReplan || replanCount >= maxReplans) {
			break;
		}

		replanCount += 1;
		emit({ type: "log", message: `⟳ master replan ${replanCount}/${maxReplans}…` });
		const replan = await masterReplan({
			control,
			task: opts.task,
			failedGraph: graph,
			templateRef,
			records,
			escalation: once.escalation,
			persist: opts.persistPlan !== false,
			onLog: (message) => emit({ type: "log", message }),
		});
		controlUsageAcc = mergeUsage(controlUsageAcc, replan.usage);
		emit({
			type: "master_replan",
			ok: replan.ok,
			why: replan.why,
			graph: replan.graph,
			templateRef: replan.baseId,
		});

		if (!replan.ok || !replan.graph) {
			emit({ type: "log", message: `master replan failed: ${replan.why}` });
			break;
		}

		graphGeneration += 1;
		graph = replan.graph;
		for (const n of graph.nodes) delete n.model;
		templateRef = replan.baseId ?? templateRef;
		templateVersion = replan.version ?? templateVersion;
		graphRevisions.push({
			generation: graphGeneration,
			templateId: templateRef,
			templateVersion,
			graph: structuredClone(graph),
			reason: "master_replan",
			startedAt: new Date().toISOString(),
		});
		cards = loadAgentCards();
		for (const n of graph.nodes) {
			if (!cards.has(n.agentCard) && !isControlHandoffNode(n)) {
				throw new Error(`replan graph node ${n.id} needs missing card ${n.agentCard}`);
			}
		}
		emit({
			type: "template_resolved",
			templateRef,
			why: replan.why,
			planMode: "master_replan",
		});
		emit({ type: "log", message: `master replan graph ready: ${templateRef} (${graph.nodes.length} nodes) — re-running` });
		emit({
			type: "run_started",
			runId,
			task: opts.task,
			templateRef,
			templateVersion,
			mode: opts.mode,
			graphGeneration,
			graph,
			cards: cardsPayload(),
			workerModel: workerModelLabel,
			controlModel: control?.modelId,
		});
	}

	const endedAt = new Date().toISOString();
	const status = computeRunStatus(records, graph, scheduler.allTerminal());

	// ---- post-run master: process verify + graph improve ----
	let improveMeta: Awaited<ReturnType<typeof masterImprove>> | undefined;
	if (enableImprove && control) {
		try {
			improveMeta = await masterImprove({
				control,
				task: opts.task,
				templateRef,
				templateVersion,
				graph,
				status,
				records,
				escalations,
				persist: opts.persistImprove !== false,
				apply: opts.persistImprove !== false,
				onLog: (message) => emit({ type: "log", message }),
			});
		} catch (err) {
			improveMeta = {
				ok: false,
				why: `post-run improve failed without affecting task result: ${String((err as Error).message)}`,
				usage: { inputTokens: 0, outputTokens: 0 },
				applied: false,
			};
		}
		controlUsageAcc = mergeUsage(controlUsageAcc, improveMeta.usage);
		emit({
			type: "master_improve",
			ok: improveMeta.ok,
			why: improveMeta.why,
			applied: improveMeta.applied,
			writtenPath: improveMeta.writtenPath,
		});
	}

	// Charge control-plane tokens into the ledger snapshot display (best-effort).
	const controlTokens = controlUsageAcc.inputTokens + controlUsageAcc.outputTokens;
	if (controlTokens > 0) {
		ledger.charge({
			input: controlUsageAcc.inputTokens,
			output: controlUsageAcc.outputTokens,
			cachedInput: 0,
			total: controlTokens,
			costMicrounits: 0,
		});
	}
	const snapFinal = ledger.snapshot();

	const files: string[] = [];
	const finalGeneration = graphGeneration;
	const terminalNodeIds = graph.edges.filter((e) => e.to === "@output").map((e) => e.from);
	const terminalRecords = terminalNodeIds
		.map((id) => latestRecordInGeneration(records, id, finalGeneration, false))
		.filter((r): r is NodeRunRecord => !!r);
	const verificationRecord = terminalRecords.find((r) => r.kind === "verifier" || r.agentCard === "verifier");
	const finalOutput = verificationRecord?.output ?? terminalRecords.at(-1)?.output ?? null;
	const verification = verificationRecord?.output ?? null;
	const safeRef = templateRef.replace(/[^a-zA-Z0-9._@-]+/g, "_");
	const artifactBase = opts.out ? join(opts.out, `${safeRef}-${runId.slice(0, 8)}`) : undefined;
	let workspaceResult: WorkspaceResult | undefined;
	let patchPath: string | undefined;

	if (isolatedWorkspace) {
		try {
			workspaceResult = captureWorkspaceResult(isolatedWorkspace);
			if (artifactBase && opts.out) {
				mkdirSync(opts.out, { recursive: true });
				patchPath = `${artifactBase}.changes.patch`;
				writeFileSync(patchPath, workspaceResult.patch);
				const workspacePath = `${artifactBase}.workspace.json`;
				writeFileSync(
					workspacePath,
					JSON.stringify(
						{
							sourceRepo: isolatedWorkspace.sourceRepoRoot,
							sourceRequestedPath: isolatedWorkspace.sourceRequestedPath,
							worktree: isolatedWorkspace.worktreeRoot,
							baseCommit: isolatedWorkspace.baseCommit,
							baselineCommit: isolatedWorkspace.baselineCommit,
							sourceWasDirty: isolatedWorkspace.sourceWasDirty,
							dependencyLinks: isolatedWorkspace.dependencyLinks,
							status: workspaceResult.status,
							changedFiles: workspaceResult.changedFiles,
							commits: workspaceResult.commits,
							verification,
							autoApplied: false,
							note: "Changes remain isolated. Review the patch/worktree before applying them to the source checkout.",
						},
						null,
						2,
					) + "\n",
				);
				files.push(patchPath, workspacePath);
			}
			emit({
				type: "workspace_result",
				worktree: isolatedWorkspace.worktreeRoot,
				changedFiles: workspaceResult.changedFiles,
				patchPath,
				verification,
				note: "not applied to source checkout",
			});
		} catch (err) {
			emit({ type: "log", message: `failed to capture isolated workspace result: ${String((err as Error).message)}` });
		}
	}

	if (opts.mode === "live" && opts.out && artifactBase) {
		const manifest: RunManifest = {
			runId,
			traceId,
			task: opts.task,
			templateId: templateRef,
			templateVersion,
			graph,
			graphRevisions,
			records,
			schedulerEvents: allSchedulerEvents,
			budget,
			startedAt,
			endedAt,
			status,
			repoRoot: executionRepo,
			inputRepoSnapshotDigest,
			modelId: workerModelLabel ?? control?.modelId ?? "pi-default",
			piVersion: "0.80.6",
		};
		mkdirSync(opts.out, { recursive: true });
		try {
			writeFileSync(`${artifactBase}.trace.json`, JSON.stringify(buildComplianceTrace(manifest), null, 2));
			writeFileSync(`${artifactBase}.pvf.json`, JSON.stringify(buildPvfTrace(manifest), null, 2));
			writeFileSync(
				`${artifactBase}.manifest.json`,
				JSON.stringify(
					{
						...manifest,
						workspace: isolatedWorkspace
							? {
									sourceRepo: isolatedWorkspace.sourceRepoRoot,
									worktree: isolatedWorkspace.worktreeRoot,
									baseCommit: isolatedWorkspace.baseCommit,
									baselineCommit: isolatedWorkspace.baselineCommit,
									changedFiles: workspaceResult?.changedFiles ?? [],
									patchPath,
									autoApplied: false,
								}
							: null,
						plan: {
							mode: plan.mode,
							why: plan.why,
							baseId: plan.baseId,
							version: plan.version,
							writtenPath: plan.writtenPath,
							controlUsage: controlUsageAcc,
							controlModel: control?.modelId,
							workerModel: workerModelLabel,
							replanCount,
							escalations,
							improve: improveMeta
								? {
										ok: improveMeta.ok,
										why: improveMeta.why,
										applied: improveMeta.applied,
										writtenPath: improveMeta.writtenPath,
									}
								: null,
						},
					},
					null,
					2,
				),
			);
			files.push(`${artifactBase}.trace.json`, `${artifactBase}.pvf.json`, `${artifactBase}.manifest.json`);
		} catch (err) {
			emit({ type: "log", message: `trace export failed without changing task result: ${String((err as Error).message)}` });
		}
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
		finalOutput,
		workspace: isolatedWorkspace
			? {
					sourceRepo: isolatedWorkspace.sourceRepoRoot,
					worktree: isolatedWorkspace.worktreeRoot,
					baselineCommit: isolatedWorkspace.baselineCommit,
					changedFiles: workspaceResult?.changedFiles ?? [],
					patchPath,
					verification,
				}
			: undefined,
	};
}

// ---- shared helpers (moved from run.ts) -------------------------------------------

/** Active graph phase = max graphGeneration among records (0 if none). */
export function activeGraphGeneration(records: NodeRunRecord[]): number {
	let max = 0;
	for (const r of records) {
		const g = r.graphGeneration ?? 0;
		if (g > max) max = g;
	}
	return max;
}

/** Latest record for nodeId within a single generation (endedAt, then attemptNo). */
function latestRecordInGeneration(
	records: NodeRunRecord[],
	nodeId: string,
	generation: number,
	requireSuccess = false,
): NodeRunRecord | undefined {
	const candidates = records.filter(
		(r) =>
			r.nodeId === nodeId &&
			(r.graphGeneration ?? 0) === generation &&
			(!requireSuccess || (r.status === "success" && r.output)),
	);
	if (candidates.length === 0) return undefined;
	return candidates.sort((a, b) => {
		if (a.endedAt !== b.endedAt) return a.endedAt < b.endedAt ? -1 : 1;
		return a.attemptNo - b.attemptNo;
	}).at(-1);
}

export function upstreamOutputs(
	nodeId: string,
	graph: WorkflowGraph,
	records: NodeRunRecord[],
	opts: { includeFeedback?: boolean } = {},
): NodeRunRecord[] {
	const producers = [...new Set(
		graph.edges
			.filter(
				(e) =>
					e.to === nodeId &&
					e.from !== "@input" &&
					(e.kind !== "FEEDBACK" || opts.includeFeedback === true),
			)
			.map((e) => e.from),
	)];
	// Scope to the active generation so a reused nodeId from a prior replan/handoff
	// phase cannot feed a later node with stale output.
	const gen = activeGraphGeneration(records);
	const picked: NodeRunRecord[] = [];
	for (const producer of producers) {
		const latest = latestRecordInGeneration(records, producer, gen, true);
		if (latest) picked.push(latest);
	}
	return picked;
}

/**
 * Single-pass prompt substitution. Values injected for ${task}/${upstream}/
 * ${master_plan} are never re-scanned, so task text containing literal
 * `${upstream}` (etc.) cannot re-expand. Unknown ${...} stay literal.
 */
export function renderPrompt(
	template: string,
	task: string,
	upstream: NodeRunRecord[],
	masterPlan = "",
): string {
	const upstreamText = upstream
		.map((r) => `### From ${r.nodeId}:\n${JSON.stringify(r.output, null, 2)}`)
		.join("\n\n");
	const map: Record<string, string> = {
		task,
		upstream: upstreamText || "(no upstream output yet)",
		master_plan: masterPlan || "(no master plan — follow task + upstream)",
	};
	return template.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name: string) =>
		Object.prototype.hasOwnProperty.call(map, name) ? map[name]! : match,
	);
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
	// Only consider records from the active (max) generation — never across phases.
	const gen = activeGraphGeneration(records);
	for (const nodeId of outputNodes) {
		const last = latestRecordInGeneration(records, nodeId, gen, false);
		if (!last || last.status !== "success") return "failure";
		const verdict = (last.output as Record<string, unknown> | null)?.verdict;
		if (verdict !== undefined && verdict !== "pass") return "failure";
	}
	return "success";
}
