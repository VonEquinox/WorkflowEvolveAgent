/**
 * Node ↔ AgentSession wrapper (L2). One node attempt = one in-process
 * AgentSession run (D7/D8), with:
 *   - role card system prompt via DefaultResourceLoader#systemPromptOverride (D19)
 *   - per-node tool allowlist
 *   - recorder inline-extension (L1 capture, budget enforcement)
 *   - JSON output contract: final assistant text must parse (D14/D21);
 *     parse failure = node failure (bounded retry is the scheduler's call).
 *
 * Models:
 *   - Worker nodes use the user's **default pi model** (settings + models.json
 *     under ~/.pi/agent), NOT the WEA control-plane endpoint.
 *   - WEA control LLM lives in wea-control.ts (planning / redesign only).
 */

import {
	AuthStorage,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./budget.ts";
import { makeRecorder, makeSink, sha256 } from "./recorder-ext.ts";
import { withCurrentTime } from "./time-banner.ts";
import type { NodeBudget, NodeOutput, NodeRunRecord } from "./types.ts";
import { validateAgentOutput } from "./schemas.ts";

export interface AgentCard {
	name: string;
	description: string;
	/** Tool allowlist; undefined = pi defaults (read/bash/edit/write). */
	tools?: string[];
	systemPrompt: string;
}

/**
 * Shared pi auth + model registry for worker nodes.
 * Resolves the same default model interactive `pi` would use.
 */
export class PiWorkerFactory {
	readonly auth: any;
	readonly registry: any;
	readonly settings: any;
	readonly agentDir: string;
	/** Resolved default model object (provider/id from ~/.pi/agent settings). */
	readonly model: any;
	readonly modelLabel: string;

	constructor(agentDir = getAgentDir()) {
		this.agentDir = agentDir;
		this.auth = AuthStorage.create(`${agentDir}/auth.json`);
		this.registry = ModelRegistry.create(this.auth, `${agentDir}/models.json`);
		this.settings = SettingsManager.create(process.cwd(), agentDir);
		const provider = this.settings.getDefaultProvider?.();
		const modelId = this.settings.getDefaultModel?.();
		let model: any | undefined;
		if (provider && modelId) {
			model = this.registry.find?.(provider, modelId);
		}
		if (!model) {
			// Fall back to first available model with configured auth.
			const all: any[] = this.registry.getAll?.() ?? this.registry.list?.() ?? [];
			model = all.find((m) => this.registry.hasConfiguredAuth?.(m)) ?? all[0];
		}
		if (!model) {
			throw new Error(
				"no default pi model available — set defaultProvider/defaultModel in ~/.pi/agent/settings.json " +
					"and ensure auth for that provider works (same as interactive pi)",
			);
		}
		this.model = model;
		this.modelLabel = `${model.provider}/${model.id}`;
	}
}

/** @deprecated use PiWorkerFactory — kept as alias for older call sites. */
export type SessionFactoryConfig = {
	/** ignored: workers no longer use WEA endpoint */
	baseUrl?: string;
	apiKey?: string;
	modelId?: string;
	templateModelId?: string;
};

/** @deprecated use PiWorkerFactory */
export class SessionFactory extends PiWorkerFactory {
	constructor(_cfg?: SessionFactoryConfig, _authPath?: string) {
		super();
	}

	/** Workers ignore model overrides — always default pi model. */
	modelFor(_modelId?: string): any {
		return this.model;
	}
}

export interface RunNodeParams {
	nodeId: string;
	attemptNo: number;
	kind: NodeRunRecord["kind"];
	card: AgentCard;
	taskPrompt: string;
	cwd: string;
	repoRoot: string;
	factory: PiWorkerFactory;
	ledger: BudgetLedger;
	timing: { plannedAt: string; readyAt: string };
	nodeBudget?: NodeBudget;
	/** Ignored: workers always use the default pi model. Kept for API compat. */
	modelOverride?: string;
	/** Optional live tap for GUI/progress: tool calls + usage as they happen. */
	onActivity?: (a: import("./recorder-ext.ts").RecorderActivity) => void;
}

/**
 * Extract the node's JSON output (D21). Tolerance ladder, strictest first:
 *   1. whole text parses;
 *   2. fenced ```json block parses;
 *   3. balanced-brace scan — models occasionally prefix/suffix prose around a
 *      valid object (observed live: "Straightforward implementation task.\n{...}").
 *      We take the LAST parseable top-level object, preferring one with "summary".
 * Parse success rate is a Phase 1 metric; failures still fail the node (bounded retry).
 */
export function parseNodeOutput(text: string): NodeOutput | null {
	const tryParse = (raw: string): NodeOutput | null => {
		try {
			const value = JSON.parse(raw);
			return value && typeof value === "object" && !Array.isArray(value) ? (value as NodeOutput) : null;
		} catch {
			return null;
		}
	};
	const direct = tryParse(text.trim());
	if (direct) return direct;
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) {
		const fenced = tryParse(fence[1]!.trim());
		if (fenced) return fenced;
	}
	// Balanced top-level {...} candidates.
	const candidates: NodeOutput[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") {
			if (depth === 0) start = i;
			depth += 1;
		} else if (ch === "}") {
			if (depth > 0) depth -= 1;
			if (depth === 0 && start >= 0) {
				const parsed = tryParse(text.slice(start, i + 1));
				if (parsed) candidates.push(parsed);
				start = -1;
			}
		}
	}
	const withSummary = candidates.filter((c) => typeof c.summary === "string");
	return withSummary.at(-1) ?? candidates.at(-1) ?? null;
}

export async function runNode(params: RunNodeParams): Promise<NodeRunRecord> {
	const { card, factory, ledger } = params;
	const sink = makeSink();
	const startedAt = new Date().toISOString();
	let finalText = "";
	let session: any = null;
	let sessionId = `failed-${params.nodeId}-${params.attemptNo}`;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	let runError: { code: string; message: string; retryable: boolean } | null = null;

	try {
		const loader = new DefaultResourceLoader({
			cwd: params.cwd,
			agentDir: factory.agentDir,
			systemPromptOverride: () => card.systemPrompt,
			appendSystemPromptOverride: () => [],
			extensionFactories: [
				{
					name: `wea-recorder-${params.nodeId}`,
					factory: makeRecorder(sink, {
						cwd: params.cwd,
						repoRoot: params.repoRoot,
						ledger,
						nodeBudget: params.nodeBudget,
						onActivity: params.onActivity,
					}),
				},
			],
		});
		await loader.reload();

		const sessionManager = SessionManager.inMemory(params.cwd);
		const created = await createAgentSession({
			cwd: params.cwd,
			agentDir: factory.agentDir,
			model: factory.model,
			authStorage: factory.auth,
			modelRegistry: factory.registry,
			resourceLoader: loader,
			sessionManager,
			tools: card.tools,
		});
		session = created.session;
		sessionId = String(session.sessionId ?? sessionId);
		session.subscribe((ev: any) => {
			if (ev.type === "message_end" && ev.message.role === "assistant") {
				finalText = ev.message.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("");
			}
		});

		const runWallRemaining = Math.max(1, ledger.snapshot().wallTimeRemaining);
		const nodeWall = params.nodeBudget?.maxWallTimeMs ?? Number.POSITIVE_INFINITY;
		const wallLimit = Math.min(runWallRemaining, nodeWall);
		const prompt = session.prompt(withCurrentTime(params.taskPrompt));
		if (Number.isFinite(wallLimit)) {
			const timeout = new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					void Promise.resolve(session?.abort?.()).catch(() => {});
					reject(new Error(`node wall-time limit exceeded after ${wallLimit}ms`));
				}, wallLimit);
			});
			await Promise.race([prompt, timeout]);
		} else {
			await prompt;
		}
	} catch (err: any) {
		if (timedOut) {
			runError = { code: "NODE_TIMEOUT", message: String(err?.message ?? err), retryable: false };
		} else {
			runError = { code: "SESSION_ERROR", message: String(err?.message ?? err), retryable: true };
		}
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (session) {
			try {
				session.dispose();
			} catch {
				// A dispose failure must not erase the node's real result/error.
			}
		}
	}

	if (sink.abortedForBudget) {
		runError = {
			code: "BUDGET_EXCEEDED",
			message: sink.budgetExceededReason ?? "run or node budget exhausted; session aborted",
			retryable: false,
		};
	}

	let output: NodeOutput | null = finalText ? parseNodeOutput(finalText) : null;
	if (!runError && output === null) {
		runError = {
			code: "OUTPUT_CONTRACT_VIOLATION",
			message: "final assistant message is not a JSON object",
			retryable: true,
		};
	}
	if (!runError && output) {
		const validation = validateAgentOutput(card.name, output);
		if (!validation.ok) {
			runError = {
				code: "OUTPUT_SCHEMA_VIOLATION",
				message: `output for ${card.name} failed runtime schema: ${validation.errors.join("; ")}`,
				retryable: true,
			};
		}
	}

	const endedAt = new Date().toISOString();
	return {
		nodeId: params.nodeId,
		attemptNo: params.attemptNo,
		graphGeneration: 0,
		agentCard: card.name,
		kind: params.kind,
		sessionId,
		systemPromptDigest: sha256(card.systemPrompt),
		toolCalls: sink.toolCalls,
		toolResults: sink.toolResults,
		usage: sink.usage,
		finalText,
		output,
		status: runError ? "failure" : "success",
		error: runError,
		plannedAt: params.timing.plannedAt,
		readyAt: params.timing.readyAt,
		startedAt,
		endedAt,
		readSet: [...sink.readSet].sort(),
		writeSet: [...sink.writeSet].sort(),
		observations: sink.observations,
		usedBash: sink.usedBash,
		redactions: sink.redactions,
	};
}
