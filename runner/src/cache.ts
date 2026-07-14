/**
 * Exact reuse cache (L3, Phase 4 minimal) — content-addressed, fail-closed.
 *
 * Before spawning a node, the runner can ask this cache "have we already run an
 * equivalent node against an identical world, and may we reuse its output?".
 * A hit skips the LLM call entirely and materializes the stored output.
 *
 * The safety stance is conservative by construction (v0.2 §4.6 MVP gate):
 *   - only PURE / READ_ONLY nodes are cacheable. A node is read-only iff it used
 *     none of edit/write AND no bash (bash is volatile — its real read-set is
 *     invisible, D10 — so any bash use makes the node uncacheable, fail-closed);
 *   - the cache KEY binds everything that could change the output: the node's
 *     role card (system prompt digest), the exact task prompt, the model id, and
 *     the repo snapshot digest (git HEAD + dirty). Any mismatch = MISS;
 *   - a certificate records WHY a hit was authorized, so a reuse is auditable and
 *     can be shown never to be a false hit.
 *
 * "Exact" here means: same operation, same inputs, same world → same bytes may be
 * reused. It never guesses. Anything unknown or volatile misses. That is the
 * whole point — a wrong reuse silently corrupts correctness, so the cache would
 * rather do nothing than reuse unsafely.
 *
 * Storage is a tiny JSON-file CAS under <cacheDir>/ (gitignored). No network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestOf, repoSnapshotDigest } from "./trace-export.ts";
import type { NodeOutput, NodeRunRecord } from "./types.ts";

/** The facts that must all match for an exact hit. */
export interface CacheKeyParts {
	/** role card identity — digest of the system prompt the node ran with. */
	systemPromptDigest: string;
	/** the exact task prompt the node was given (after ${...} substitution). */
	taskPrompt: string;
	/** WEA endpoint model id (per-node override or run model). */
	modelId: string;
	/** repo world identity: git HEAD + dirty digest. */
	repoSnapshotDigest: string;
}

export interface ReuseCertificate {
	cache_key: string;
	authorized_mode: "EXACT";
	/** every fact that had to match, echoed for audit. */
	bound: CacheKeyParts;
	/** why this node was eligible at all. */
	eligibility: string;
	stored_at: string;
	source_session_id: string;
}

interface CacheEntry {
	certificate: ReuseCertificate;
	output: NodeOutput;
	/** kept for audit; never re-read for correctness. */
	final_text: string;
}

export type ReuseDecision =
	| { hit: true; output: NodeOutput; certificate: ReuseCertificate }
	| { hit: false; reason: string };

/** A node is cacheable only if it did pure read-only work. Fail-closed. */
export function isCacheable(record: Pick<NodeRunRecord, "writeSet" | "usedBash" | "toolCalls">): {
	ok: boolean;
	reason: string;
} {
	if (record.usedBash) return { ok: false, reason: "used bash (volatile read-set, D10) — not cacheable" };
	if (record.writeSet.length > 0) return { ok: false, reason: "wrote files — not a pure/read-only node" };
	const wroteViaTool = record.toolCalls.some((t) => t.tool === "edit" || t.tool === "write");
	if (wroteViaTool) return { ok: false, reason: "used edit/write tools — not read-only" };
	return { ok: true, reason: "pure/read-only: no bash, no writes" };
}

export function cacheKey(parts: CacheKeyParts): string {
	return digestOf({
		v: "wea.cache/v1",
		sys: parts.systemPromptDigest,
		task: parts.taskPrompt,
		model: parts.modelId,
		snapshot: parts.repoSnapshotDigest,
	});
}

export class ExactCache {
	constructor(private readonly dir: string) {
		mkdirSync(dir, { recursive: true });
	}

	private path(key: string): string {
		// key is "sha256:hex"; strip the scheme for a filename.
		return join(this.dir, key.replace(":", "_") + ".json");
	}

	/** Look up a node before running it. Returns a hit only when fully sound. */
	lookup(parts: CacheKeyParts): ReuseDecision {
		const key = cacheKey(parts);
		const p = this.path(key);
		if (!existsSync(p)) return { hit: false, reason: "no entry for this exact key" };
		const entry = JSON.parse(readFileSync(p, "utf8")) as CacheEntry;
		// Defense in depth: re-verify every bound fact rather than trusting the file.
		const c = entry.certificate;
		const same =
			c.bound.systemPromptDigest === parts.systemPromptDigest &&
			c.bound.taskPrompt === parts.taskPrompt &&
			c.bound.modelId === parts.modelId &&
			c.bound.repoSnapshotDigest === parts.repoSnapshotDigest;
		if (!same) return { hit: false, reason: "stored certificate does not match the requested world (fail-closed)" };
		return { hit: true, output: entry.output, certificate: c };
	}

	/** Store a completed read-only node's output for future exact reuse. */
	store(parts: CacheKeyParts, record: NodeRunRecord): { stored: boolean; reason: string } {
		const elig = isCacheable(record);
		if (!elig.ok) return { stored: false, reason: elig.reason };
		if (record.status !== "success" || !record.output) {
			return { stored: false, reason: "only successful nodes with parsed output are cacheable" };
		}
		const key = cacheKey(parts);
		const certificate: ReuseCertificate = {
			cache_key: key,
			authorized_mode: "EXACT",
			bound: parts,
			eligibility: elig.reason,
			stored_at: new Date().toISOString(),
			source_session_id: record.sessionId,
		};
		const entry: CacheEntry = { certificate, output: record.output, final_text: record.finalText };
		writeFileSync(this.path(key), JSON.stringify(entry, null, 2));
		return { stored: true, reason: elig.reason };
	}
}

/** Build the key parts for a node about to run (or just finished). */
export function keyPartsFor(args: {
	systemPromptDigest: string;
	taskPrompt: string;
	modelId: string;
	repoRoot: string;
}): CacheKeyParts {
	return {
		systemPromptDigest: args.systemPromptDigest,
		taskPrompt: args.taskPrompt,
		modelId: args.modelId,
		repoSnapshotDigest: repoSnapshotDigest(args.repoRoot),
	};
}
