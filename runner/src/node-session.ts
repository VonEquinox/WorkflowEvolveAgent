/**
 * Node ↔ AgentSession wrapper (L2). One node attempt = one in-process
 * AgentSession run (D7/D8), with:
 *   - role card system prompt via DefaultResourceLoader#systemPromptOverride (D19)
 *   - per-node tool allowlist
 *   - recorder inline-extension (L1 capture, budget enforcement)
 *   - JSON output contract: final assistant text must parse (D14/D21);
 *     parse failure = node failure (bounded retry is the scheduler's call).
 */

import {
	AuthStorage,
	ModelRegistry,
	SessionManager,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./budget.ts";
import { makeRecorder, makeSink, sha256 } from "./recorder-ext.ts";
import type { NodeOutput, NodeRunRecord } from "./types.ts";

export interface AgentCard {
	name: string;
	description: string;
	/** Tool allowlist; undefined = pi defaults (read/bash/edit/write). */
	tools?: string[];
	systemPrompt: string;
}

export interface SessionFactoryConfig {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	/** Registry template model id to clone provider/api metadata from. */
	templateModelId?: string;
}

/** Process-wide singletons (FINDINGS U3: share one auth + registry across nodes). */
export class SessionFactory {
	readonly auth: any;
	readonly registry: any;
	readonly model: any;

	constructor(cfg: SessionFactoryConfig, authPath = "/tmp/wea-runner-auth.json") {
		this.auth = AuthStorage.create(authPath);
		this.auth.setRuntimeApiKey("anthropic", cfg.apiKey);
		this.registry = ModelRegistry.inMemory(this.auth);
		const template = this.registry
			.getAll()
			.find((m: any) => m.provider === "anthropic" && m.id === (cfg.templateModelId ?? "claude-sonnet-5"));
		if (!template) throw new Error("template model not found in pi registry");
		this.baseTemplate = template;
		this.baseUrl = cfg.baseUrl;
		this.model = { ...template, id: cfg.modelId, baseUrl: cfg.baseUrl };
	}

	private readonly baseTemplate: any;
	private readonly baseUrl: string;

	/** A model object for a specific WEA endpoint model id (per-node override). */
	modelFor(modelId: string | undefined): any {
		if (!modelId) return this.model;
		return { ...this.baseTemplate, id: modelId, baseUrl: this.baseUrl };
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
	factory: SessionFactory;
	ledger: BudgetLedger;
	timing: { plannedAt: string; readyAt: string };
	/** Per-node model override (WEA endpoint model id); omitted = run-level model. */
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

	const loader = new DefaultResourceLoader({
		cwd: params.cwd,
		agentDir: getAgentDir(),
		systemPromptOverride: () => card.systemPrompt,
		appendSystemPromptOverride: () => [],
		extensionFactories: [
			{
				name: `wea-recorder-${params.nodeId}`,
				factory: makeRecorder(sink, {
					cwd: params.cwd,
					repoRoot: params.repoRoot,
					ledger,
					onActivity: params.onActivity,
				}),
			},
		],
	});
	await loader.reload();

	const sessionManager = SessionManager.inMemory(params.cwd);
	const { session } = await createAgentSession({
		cwd: params.cwd,
		model: factory.modelFor(params.modelOverride),
		authStorage: factory.auth,
		modelRegistry: factory.registry,
		resourceLoader: loader,
		sessionManager,
		tools: card.tools,
	});

	let finalText = "";
	session.subscribe((ev: any) => {
		if (ev.type === "message_end" && ev.message.role === "assistant") {
			finalText = ev.message.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");
		}
	});

	const startedAt = new Date().toISOString();
	let runError: { code: string; message: string; retryable: boolean } | null = null;
	try {
		await session.prompt(params.taskPrompt);
	} catch (err: any) {
		runError = { code: "SESSION_ERROR", message: String(err?.message ?? err), retryable: true };
	}
	const endedAt = new Date().toISOString();
	const sessionId = session.sessionId as string;
	session.dispose();

	if (!runError && sink.abortedForBudget) {
		runError = { code: "BUDGET_EXCEEDED", message: "run budget exhausted; session aborted", retryable: false };
	}

	const output = runError ? null : parseNodeOutput(finalText);
	if (!runError && output === null) {
		runError = {
			code: "OUTPUT_CONTRACT_VIOLATION",
			message: "final assistant message is not the agreed JSON object",
			retryable: true,
		};
	}

	return {
		nodeId: params.nodeId,
		attemptNo: params.attemptNo,
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
