/**
 * WEA control-plane LLM — used only for orchestration decisions:
 *   - task classification / family routing
 *   - pre-run template adaptation (edit existing graph)
 *   - cold-start graph synthesis when the catalog is a poor fit
 *
 * Worker nodes (inspect / implement / verify / …) do NOT use this client.
 * They run through pi AgentSessions with the user's default pi model.
 *
 * Env (aliases accepted):
 *   WEA_BASE_URL | WEA_CONTROL_BASE_URL
 *   WEA_API_KEY  | WEA_CONTROL_API_KEY
 *   WEA_MODEL    | WEA_CONTROL_MODEL
 *   WEA_CONTROL_TIMEOUT_MS (default 60000)
 *   WEA_CONTROL_MAX_RETRIES (default 2)
 */

import { withCurrentTime } from "./time-banner.ts";

export interface WeaControlConfig {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	/** Per-attempt HTTP deadline. */
	timeoutMs?: number;
	/** Additional attempts after the first request. */
	maxRetries?: number;
}

export interface ControlUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface ControlMessageResult {
	text: string;
	usage: ControlUsage;
	raw: unknown;
}

function envInteger(raw: string | undefined, fallback: number, min: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= min ? value : fallback;
}

export function loadWeaControlConfig(env: NodeJS.ProcessEnv = process.env): WeaControlConfig | null {
	const baseUrl = env.WEA_CONTROL_BASE_URL ?? env.WEA_BASE_URL;
	const apiKey = env.WEA_CONTROL_API_KEY ?? env.WEA_API_KEY;
	const modelId = env.WEA_CONTROL_MODEL ?? env.WEA_MODEL;
	if (!baseUrl || !apiKey || !modelId) return null;
	return {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		apiKey,
		modelId,
		timeoutMs: envInteger(env.WEA_CONTROL_TIMEOUT_MS, 60_000, 1),
		maxRetries: envInteger(env.WEA_CONTROL_MAX_RETRIES, 2, 0),
	};
}

export function requireWeaControlConfig(env: NodeJS.ProcessEnv = process.env): WeaControlConfig {
	const cfg = loadWeaControlConfig(env);
	if (!cfg) {
		throw new Error(
			"set WEA_BASE_URL / WEA_API_KEY / WEA_MODEL " +
				"(or WEA_CONTROL_BASE_URL / WEA_CONTROL_API_KEY / WEA_CONTROL_MODEL) for the WEA control plane",
		);
	}
	return cfg;
}

/** Internal typed failure so retry policy never treats a permanent 4xx as a network error. */
class ControlRequestError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
		readonly status?: number,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "ControlRequestError";
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelayMs(attempt: number, retryAfter: string | null): number {
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, seconds * 1000);
		const date = Date.parse(retryAfter);
		if (Number.isFinite(date)) return Math.max(0, Math.min(10_000, date - Date.now()));
	}
	return Math.min(2_000, 250 * 2 ** attempt);
}

/**
 * One-shot Anthropic-messages call (no tools). Used for planning / redesign JSON.
 * Transient network failures, deadlines, 408/429, and 5xx responses are retried.
 */
export async function controlComplete(
	cfg: WeaControlConfig,
	args: {
		system: string;
		user: string;
		maxTokens?: number;
		temperature?: number;
	},
): Promise<ControlMessageResult> {
	const url = `${cfg.baseUrl}/messages`;
	const body = {
		model: cfg.modelId,
		max_tokens: args.maxTokens ?? 4096,
		temperature: args.temperature ?? 0.2,
		system: args.system,
		messages: [{ role: "user", content: withCurrentTime(args.user) }],
	};
	const timeoutMs = Math.max(1, cfg.timeoutMs ?? 60_000);
	const maxRetries = Math.max(0, Math.floor(cfg.maxRetries ?? 2));
	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": cfg.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			const rawText = await res.text();
			let raw: any = null;
			try {
				raw = JSON.parse(rawText);
			} catch {
				// Preserve status-based retry policy even if an error proxy returns HTML.
			}
			if (!res.ok) {
				const msg = raw?.error?.message ?? raw?.message ?? rawText.slice(0, 300);
				const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
				throw new ControlRequestError(
					`WEA control LLM HTTP ${res.status}: ${msg}`,
					retryable,
					res.status,
					retryDelayMs(attempt, res.headers.get("retry-after")),
				);
			}
			if (raw === null) {
				throw new ControlRequestError(
					`WEA control LLM returned non-JSON (HTTP ${res.status}): ${rawText.slice(0, 300)}`,
					false,
					res.status,
				);
			}
			const parts = Array.isArray(raw?.content) ? raw.content : [];
			const text = parts
				.filter((c: any) => c?.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text as string)
				.join("");
			const usage: ControlUsage = {
				inputTokens: Number(raw?.usage?.input_tokens ?? 0),
				outputTokens: Number(raw?.usage?.output_tokens ?? 0),
			};
			return { text, usage, raw };
		} catch (err: any) {
			const failure = err instanceof ControlRequestError
				? err
				: controller.signal.aborted
					? new ControlRequestError(`WEA control LLM timed out after ${timeoutMs}ms`, true)
					: new ControlRequestError(`WEA control LLM request failed: ${err?.message ?? String(err)}`, true);
			lastError = failure;
			if (!failure.retryable || attempt >= maxRetries) throw failure;
			await sleep(failure.retryAfterMs ?? retryDelayMs(attempt, null));
		} finally {
			clearTimeout(timer);
		}
	}

	throw lastError ?? new Error("WEA control LLM request failed");
}

/** Extract a JSON object from model text (whole / fence / balanced braces). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
	const tryParse = (raw: string): Record<string, unknown> | null => {
		try {
			const v = JSON.parse(raw);
			return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
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
	const candidates: Record<string, unknown>[] = [];
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
	return candidates.at(-1) ?? null;
}
