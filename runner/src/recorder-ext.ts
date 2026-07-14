/**
 * Recorder inline-extension — L1 capture layer (D9/D20/D22/D23).
 *
 * One recorder per node session. Captures into an in-memory sink:
 *   - tool_call inputs (typed; paths/patterns feed the read/write set)
 *   - tool_result content digests (pi provides no digest — FINDINGS U5 — so we
 *     sha256 the text the model actually saw, per D22)
 *   - message_end usage (charged to the BudgetLedger; over-budget → ctx.abort())
 *
 * Persistence is fully ours (D20): nothing here relies on the pi session file.
 * Sensitive paths are redacted at capture time (D23/SEC-001): the path is kept,
 * but the content digest is replaced by the digest of a fixed placeholder and
 * the observation is marked conservative.
 */

import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { BudgetLedger } from "./budget.ts";
import { toUsageSample } from "./budget.ts";
import type { ToolCallSample, ToolResultSample, UsageSample } from "./types.ts";

export const sha256 = (data: string | Buffer): string =>
	"sha256:" + createHash("sha256").update(data).digest("hex");

/** Digest recorded for redacted reads — derived from the path, never the content. */
export const redactedDigest = (path: string): string => sha256(`wea:redacted:${path}`);

const DEFAULT_SENSITIVE = [
	/(^|\/)\.env($|\.)/i,
	/\.(key|pem|p12|pfx)$/i,
	/(^|\/)(credentials|secrets?)(\.|$|\/)/i,
	/(^|\/)\.git\/(config|credentials)$/,
	/(^|\/)auth\.json$/i,
];

export function isSensitivePath(path: string, extra: RegExp[] = []): boolean {
	return [...DEFAULT_SENSITIVE, ...extra].some((re) => re.test(path));
}

/** Normalize a tool-supplied path: resolve against cwd, prefer repo-relative (D23). */
export function normalizePath(raw: string, cwd: string, repoRoot: string): string {
	const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
	const rel = relative(repoRoot, abs);
	return rel.startsWith("..") ? abs : rel === "" ? "." : rel;
}

/** One dependency observation in the wea.trace/v1 vocabulary. */
export interface DependencyObservation {
	kind:
		| "file_content"
		| "file_metadata"
		| "directory_membership"
		| "absence"
		| "glob_result"
		| "search_result"
		| "env"
		| "toolchain"
		| "model_runtime"
		| "node_output"
		| "network"
		| "clock"
		| "random";
	locator: string;
	selector_digest: string | null;
	observed_digest: string;
	provenance: "declared" | "discovered";
	capture_method: "tool_wrapper";
	completeness: "complete" | "conservative" | "incomplete";
}

export interface RecorderSink {
	toolCalls: ToolCallSample[];
	toolResults: ToolResultSample[];
	usage: UsageSample[];
	observations: DependencyObservation[];
	/** repo-relative (or absolute if outside repo) read/write paths, deduped. */
	readSet: Set<string>;
	writeSet: Set<string>;
	usedBash: boolean;
	abortedForBudget: boolean;
	redactions: number;
}

export function makeSink(): RecorderSink {
	return {
		toolCalls: [],
		toolResults: [],
		usage: [],
		observations: [],
		readSet: new Set(),
		writeSet: new Set(),
		usedBash: false,
		abortedForBudget: false,
		redactions: 0,
	};
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

/** A live activity ping from inside a node session (for GUI/progress surfaces). */
export type RecorderActivity =
	| { kind: "tool_call"; tool: string; detail: string }
	| { kind: "tool_result"; tool: string; isError: boolean; chars: number }
	| { kind: "llm"; inputTokens: number; outputTokens: number; costMicrounits: number };

interface RecorderOptions {
	cwd: string;
	repoRoot: string;
	ledger: BudgetLedger;
	sensitive?: RegExp[];
	/** optional live tap — fired as events happen, in addition to the sink. */
	onActivity?: (a: RecorderActivity) => void;
}

/** One-line human summary of a tool call's input (for live progress display). */
function summarizeInput(tool: string, input: Record<string, unknown>): string {
	const s = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v) ?? "");
	if (typeof input.path === "string") return input.path;
	if (typeof input.pattern === "string") return input.pattern;
	if (typeof input.command === "string") return s(input.command).slice(0, 80);
	if (typeof input.file_path === "string") return input.file_path;
	const first = Object.values(input)[0];
	return first === undefined ? tool : s(first).slice(0, 80);
}

/**
 * Build the InlineExtension factory for one node session.
 * pi typing note: we accept `pi: any` because the runner package consumes the
 * published pi API only through this single seam (kept narrow deliberately).
 */
export function makeRecorder(sink: RecorderSink, opts: RecorderOptions) {
	const seenResultDigests = new Map<string, string>(); // toolCallId → content digest
	return (pi: any) => {
		pi.on("tool_call", async (event: any) => {
			sink.toolCalls.push({ tool: event.toolName, toolCallId: event.toolCallId, input: { ...event.input } });
			if (event.toolName === "bash") sink.usedBash = true;
			opts.onActivity?.({ kind: "tool_call", tool: event.toolName, detail: summarizeInput(event.toolName, event.input ?? {}) });
			return undefined; // observe only, never block/mutate
		});

		pi.on("tool_result", async (event: any) => {
			const text = (event.content ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			const tool = event.toolName;
			const input = event.input ?? {};
			const rawPath = typeof input.path === "string" ? input.path : null;
			const pattern = typeof input.pattern === "string" ? input.pattern : null;

			let contentDigest = sha256(text);
			if (READ_TOOLS.has(tool) && !event.isError) {
				if (tool === "read" && rawPath) {
					const norm = normalizePath(rawPath, opts.cwd, opts.repoRoot);
					const sensitive = isSensitivePath(norm, opts.sensitive);
					if (sensitive) {
						contentDigest = redactedDigest(norm);
						sink.redactions += 1;
					}
					sink.readSet.add(norm);
					sink.observations.push({
						kind: "file_content",
						locator: norm,
						selector_digest: null,
						observed_digest: contentDigest,
						provenance: "discovered",
						capture_method: "tool_wrapper",
						completeness: sensitive ? "conservative" : "complete",
					});
				} else if (tool === "grep" && pattern) {
					sink.observations.push({
						kind: "search_result",
						locator: rawPath ? normalizePath(rawPath, opts.cwd, opts.repoRoot) + "#" + pattern : pattern,
						selector_digest: sha256(pattern),
						observed_digest: contentDigest,
						provenance: "discovered",
						capture_method: "tool_wrapper",
						completeness: "complete",
					});
				} else if (tool === "find" && pattern) {
					sink.observations.push({
						kind: "glob_result",
						locator: pattern,
						selector_digest: sha256(pattern),
						observed_digest: contentDigest,
						provenance: "discovered",
						capture_method: "tool_wrapper",
						completeness: "complete",
					});
				} else if (tool === "ls" && rawPath) {
					const norm = normalizePath(rawPath, opts.cwd, opts.repoRoot);
					sink.observations.push({
						kind: "directory_membership",
						locator: norm,
						selector_digest: null,
						observed_digest: contentDigest,
						provenance: "discovered",
						capture_method: "tool_wrapper",
						completeness: "complete",
					});
				}
			}
			if (WRITE_TOOLS.has(tool) && !event.isError && rawPath) {
				sink.writeSet.add(normalizePath(rawPath, opts.cwd, opts.repoRoot));
			}
			sink.toolResults.push({
				tool,
				toolCallId: event.toolCallId,
				isError: !!event.isError,
				contentDigest,
				details: event.details ?? null,
			});
			seenResultDigests.set(event.toolCallId, contentDigest);
			opts.onActivity?.({ kind: "tool_result", tool, isError: !!event.isError, chars: text.length });
			return undefined;
		});

		pi.on("message_end", async (event: any, ctx: any) => {
			const m = event.message;
			if (m?.role === "assistant" && m.usage) {
				const sample = toUsageSample(m.usage);
				sink.usage.push(sample);
				opts.onActivity?.({
					kind: "llm",
					inputTokens: sample.input,
					outputTokens: sample.output,
					costMicrounits: sample.costMicrounits,
				});
				if (opts.ledger.charge(sample)) {
					sink.abortedForBudget = true;
					ctx?.abort?.(); // hard budget enforcement (§6)
				}
			}
			return undefined;
		});
	};
}
