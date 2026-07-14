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
 */

export interface WeaControlConfig {
	baseUrl: string;
	apiKey: string;
	modelId: string;
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

export function loadWeaControlConfig(env: NodeJS.ProcessEnv = process.env): WeaControlConfig | null {
	const baseUrl = env.WEA_CONTROL_BASE_URL ?? env.WEA_BASE_URL;
	const apiKey = env.WEA_CONTROL_API_KEY ?? env.WEA_API_KEY;
	const modelId = env.WEA_CONTROL_MODEL ?? env.WEA_MODEL;
	if (!baseUrl || !apiKey || !modelId) return null;
	return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, modelId };
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

/**
 * One-shot Anthropic-messages call (no tools). Used for planning / redesign JSON.
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
		messages: [{ role: "user", content: args.user }],
	};
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": cfg.apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify(body),
	});
	const rawText = await res.text();
	let raw: any;
	try {
		raw = JSON.parse(rawText);
	} catch {
		throw new Error(`WEA control LLM returned non-JSON (HTTP ${res.status}): ${rawText.slice(0, 300)}`);
	}
	if (!res.ok) {
		const msg = raw?.error?.message ?? raw?.message ?? rawText.slice(0, 300);
		throw new Error(`WEA control LLM HTTP ${res.status}: ${msg}`);
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
