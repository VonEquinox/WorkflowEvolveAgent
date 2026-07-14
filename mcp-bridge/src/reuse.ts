/**
 * Reuse + trace for MCP calls (B1/B2) — this is what loosens D10.
 *
 * A raw bash command (`curl ...`, `psql ...`) is volatile: its real read-set is
 * invisible, so per D10 it can never be safely reused. But a call THROUGH the
 * bridge is fully structured — server + tool + explicit args + the tool's own
 * read-only annotation. That makes two things possible that raw bash cannot:
 *
 *   B1 (observe): every call becomes a structured trace observation — who was
 *       called, with what, what the result digest was — so it shows up in the
 *       trace like any other dependency, not as an opaque shell blob.
 *
 *   B2 (reuse):  a read-only, non-destructive MCP call is exact-cacheable. The
 *       key is (server, tool, canonical args). A repeat of the identical call
 *       returns the stored result with a certificate; anything effectful or
 *       unknown is never cached (fail-closed, same stance as the runner cache).
 *
 * There is deliberately no repo-snapshot term here: an MCP server is its own
 * world. If a server's data can change under you, its tools should not be marked
 * read-only — and if they aren't, we don't cache them. We trust the server's own
 * annotation and otherwise fail closed.
 */

import { createHash } from "node:crypto";

const sha256 = (s: string): string => "sha256:" + createHash("sha256").update(s).digest("hex");

/** Deterministic JSON for keying args regardless of property order. */
function canonical(value: unknown): string {
	const sort = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(sort)
			: v && typeof v === "object"
				? Object.fromEntries(
						Object.entries(v as Record<string, unknown>)
							.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
							.map(([k, val]) => [k, sort(val)]),
					)
				: v;
	return JSON.stringify(sort(value));
}

/** The record every completed call produces (shape of the bridge onCall hook). */
export interface McpCallRecord {
	server: string;
	tool: string;
	args: unknown;
	isError: boolean;
	digest: string;
	readOnly: boolean;
	destructive: boolean;
}

/** B1 — a trace-ready observation for an MCP call. */
export interface McpObservation {
	kind: "mcp_call";
	server: string;
	tool: string;
	/** digest of canonical args — identifies the request without leaking values. */
	args_digest: string;
	/** digest of the returned text — identifies the result bytes. */
	result_digest: string;
	read_only: boolean;
	is_error: boolean;
}

export function toObservation(rec: McpCallRecord): McpObservation {
	return {
		kind: "mcp_call",
		server: rec.server,
		tool: rec.tool,
		args_digest: sha256(canonical(rec.args)),
		result_digest: rec.digest,
		read_only: rec.readOnly,
		is_error: rec.isError,
	};
}

/** B2 — is this call safe to reuse from cache? Fail-closed. */
export function mcpCacheable(rec: Pick<McpCallRecord, "readOnly" | "destructive" | "isError">): {
	ok: boolean;
	reason: string;
} {
	if (rec.isError) return { ok: false, reason: "errored call — not cacheable" };
	if (rec.destructive) return { ok: false, reason: "destructive tool — never cached (D10 stance)" };
	if (!rec.readOnly) return { ok: false, reason: "tool not annotated read-only — fail-closed, not cached" };
	return { ok: true, reason: "read-only, non-destructive MCP call — exact-reusable" };
}

/** Cache key for an MCP call: server + tool + canonical args. No repo snapshot. */
export function mcpCacheKey(server: string, tool: string, args: unknown): string {
	return sha256(canonical({ v: "wea.mcp.cache/v1", server, tool, args }));
}

export interface McpReuseCertificate {
	cache_key: string;
	server: string;
	tool: string;
	args_digest: string;
	result_digest: string;
	authorized: "EXACT";
	eligibility: string;
	stored_at: string;
}

/** In-memory exact cache for read-only MCP results (per session lifetime). */
export class McpExactCache {
	private entries = new Map<string, { text: string; certificate: McpReuseCertificate }>();

	lookup(server: string, tool: string, args: unknown): { hit: true; text: string; certificate: McpReuseCertificate } | { hit: false } {
		const key = mcpCacheKey(server, tool, args);
		const e = this.entries.get(key);
		return e ? { hit: true, text: e.text, certificate: e.certificate } : { hit: false };
	}

	/** Store a completed read-only call. Returns whether it was accepted. */
	store(rec: McpCallRecord, text: string): { stored: boolean; reason: string } {
		const elig = mcpCacheable(rec);
		if (!elig.ok) return { stored: false, reason: elig.reason };
		const key = mcpCacheKey(rec.server, rec.tool, rec.args);
		this.entries.set(key, {
			text,
			certificate: {
				cache_key: key,
				server: rec.server,
				tool: rec.tool,
				args_digest: sha256(canonical(rec.args)),
				result_digest: rec.digest,
				authorized: "EXACT",
				eligibility: elig.reason,
				stored_at: new Date().toISOString(),
			},
		});
		return { stored: true, reason: elig.reason };
	}

	get size(): number {
		return this.entries.size;
	}
}
