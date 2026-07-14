/**
 * Trace export (L1→contract layer). One in-memory RunManifest is projected into
 * TWO documents (D9, refined 2026-07-14):
 *
 *   1. wea.trace/v1     — compliance trace; must pass tools/validate_ir.py
 *                         (structural + fail-closed semantic gates).
 *   2. wea.pvf.trace/v1 — PVF attribution input for prototypes/attribution.py
 *                         (occurrences/artifacts/relations/anchors).
 *
 * Contract notes baked in from the schema + validator source:
 *   - additionalProperties:false everywhere → emit EXACTLY the schema fields;
 *   - LLM nodes are nondeterministic → replay_policy "verify", never "safe";
 *   - Phase 1 has no cache → cache_decision DISABLED/DISABLED (no gate demands);
 *   - budget is a hard validator ceiling: sum(tokens/money) and each attempt's
 *     wall_time must fit. We export the configured ceiling exactly so any
 *     overshoot remains visible instead of being normalized away;
 *   - dependency manifests stay "conservative" in Phase 1 (no sandbox capture;
 *     bash footprints invisible per D10).
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./recorder-ext.ts";
import type { DependencyObservation } from "./recorder-ext.ts";
import type { SchedulerEvent } from "./graph.ts";
import type { NodeRunRecord, RunBudget, WorkflowGraph } from "./types.ts";

export interface GraphRevision {
	generation: number;
	templateId: string;
	templateVersion: string;
	graph: WorkflowGraph;
	reason: "initial" | "master_handoff" | "master_replan";
	startedAt: string;
}

export interface RunManifest {
	runId: string; // uuid
	traceId: string; // 32 hex
	task: string;
	templateId: string; // e.g. "t2-bugfix"
	templateVersion: string; // semver
	graph: WorkflowGraph;
	/** Every graph phase that ran; graph remains the final revision for compatibility. */
	graphRevisions?: GraphRevision[];
	records: NodeRunRecord[]; // one per attempt, ordered by start time
	schedulerEvents: Array<SchedulerEvent & { graphGeneration?: number }>;
	budget: RunBudget;
	startedAt: string;
	endedAt: string;
	status: "success" | "failure" | "cancelled";
	repoRoot: string;
	/** Snapshot captured before the first worker changed the isolated workspace. */
	inputRepoSnapshotDigest?: string;
	modelId: string;
	piVersion: string;
}

// ---- canonical JSON + ids ----------------------------------------------------

export function canonicalJson(value: unknown): string {
	const sort = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sort);
		if (v && typeof v === "object") {
			return Object.fromEntries(
				Object.entries(v as Record<string, unknown>)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([k, val]) => [k, sort(val)]),
			);
		}
		return v;
	};
	return JSON.stringify(sort(value));
}

export const digestOf = (value: unknown): string => sha256(canonicalJson(value));

/** Drop structural duplicates (schema arrays are uniqueItems). Order preserved. */
function dedupeByCanonical<T>(items: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const key = canonicalJson(item);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}

export const newTraceId = (): string => randomUUID().replaceAll("-", "");
export const newSpanId = (): string => randomUUID().replaceAll("-", "").slice(0, 16);

/** git HEAD + dirty status digest; deterministic fallback outside git repos. */
export function repoSnapshotDigest(repoRoot: string): string {
	try {
		if (existsSync(join(repoRoot, ".git"))) {
			const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			const dirty = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], { encoding: "utf8" });
			return sha256(`git:${head}\n${dirty}`);
		}
	} catch {
		/* fall through */
	}
	return sha256(`nogit:${repoRoot}`);
}

// ---- executed dependency resolution -------------------------------------------

const occId = (r: NodeRunRecord): string => `g${r.graphGeneration ?? 0}:${r.nodeId}#${r.attemptNo}`;

function revisionsOf(manifest: RunManifest): GraphRevision[] {
	return manifest.graphRevisions?.length
		? manifest.graphRevisions
		: [{ generation: 0, templateId: manifest.templateId, templateVersion: manifest.templateVersion, graph: manifest.graph, reason: "initial", startedAt: manifest.startedAt }];
}

function graphForGeneration(manifest: RunManifest, generation: number): WorkflowGraph {
	return revisionsOf(manifest).find((r) => r.generation === generation)?.graph ?? manifest.graph;
}

/**
 * For each record, its executed predecessors: for every incoming edge, the
 * latest record of the producer that ENDED before this record STARTED.
 * FEEDBACK edges count too — they carry the verifier's verdict into the next
 * loop pass — but are naturally time-gated (no producer record exists for the
 * first attempt, so they bind only from iteration 2 onward).
 */
export function executedPredecessors(manifest: RunManifest): Map<string, NodeRunRecord[]> {
	const byGenerationAndNode = new Map<string, NodeRunRecord[]>();
	for (const record of manifest.records) {
		const key = `${record.graphGeneration ?? 0}:${record.nodeId}`;
		const list = byGenerationAndNode.get(key) ?? [];
		list.push(record);
		byGenerationAndNode.set(key, list);
	}
	const result = new Map<string, NodeRunRecord[]>();
	for (const record of manifest.records) {
		const generation = record.graphGeneration ?? 0;
		const graph = graphForGeneration(manifest, generation);
		const producers = graph.edges
			.filter((edge) => edge.to === record.nodeId && edge.from !== "@input" && edge.to !== "@output")
			.map((edge) => edge.from);
		const preds: NodeRunRecord[] = [];
		for (const producer of producers) {
			const candidates = (byGenerationAndNode.get(`${generation}:${producer}`) ?? [])
				.filter((p) => p.status === "success" && p.endedAt <= record.startedAt)
				.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : a.attemptNo - b.attemptNo));
			const latest = candidates.at(-1);
			if (latest) preds.push(latest);
		}
		result.set(occId(record), preds);
	}
	return result;
}

/** Longest wall-time path over the executed occurrence DAG → set of critical occ ids. */
export function criticalPath(manifest: RunManifest, preds: Map<string, NodeRunRecord[]>): Set<string> {
	const wall = (r: NodeRunRecord) => Math.max(1, Date.parse(r.endedAt) - Date.parse(r.startedAt));
	const byOcc = new Map(manifest.records.map((r) => [occId(r), r]));
	const memo = new Map<string, { total: number; prev: string | null }>();
	const longest = (id: string): { total: number; prev: string | null } => {
		const hit = memo.get(id);
		if (hit) return hit;
		const rec = byOcc.get(id)!;
		let best: { total: number; prev: string | null } = { total: wall(rec), prev: null };
		for (const p of preds.get(id) ?? []) {
			const sub = longest(occId(p));
			if (sub.total + wall(rec) > best.total) best = { total: sub.total + wall(rec), prev: occId(p) };
		}
		memo.set(id, best);
		return best;
	};
	let tailId: string | null = null;
	let tailTotal = -1;
	for (const r of manifest.records) {
		const { total } = longest(occId(r));
		if (total > tailTotal) {
			tailTotal = total;
			tailId = occId(r);
		}
	}
	const critical = new Set<string>();
	while (tailId) {
		critical.add(tailId);
		tailId = memo.get(tailId)!.prev;
	}
	return critical;
}

// ---- wea.trace/v1 --------------------------------------------------------------

export function buildComplianceTrace(manifest: RunManifest): Record<string, unknown> {
	const graphRevisions = revisionsOf(manifest);
	const graphDigest = digestOf(graphRevisions);
	const specDigest = digestOf({ template: manifest.templateId, graphRevisions });
	const releaseDigest = digestOf({ spec: specDigest, version: manifest.templateVersion });
	const instanceId = digestOf({ release: releaseDigest, task: manifest.task, runId: manifest.runId });
	const instanceSpecDigest = digestOf({ instance: instanceId, graph: graphDigest });

	const preds = executedPredecessors(manifest);

	// Export the configured ceiling exactly. Overshoot must remain visible to
	// validators/auditors rather than being hidden by inflating the budget.
	const budget = {
		wall_time_ms: manifest.budget.wallTimeMs,
		model_tokens: manifest.budget.modelTokens,
		monetary_microunits: manifest.budget.monetaryMicrounits,
	};

	const grantedPermissions = {
		capabilities: ["model.invoke", "process.exec", "repo.read", "repo.write"],
		filesystem: { read: ["workspace://repo"], write: ["workspace://repo"] },
		network: "deny",
		secrets: [] as string[],
	};

	const attempts = manifest.records.map((r) => {
		const writes = r.writeSet.length > 0;
		const usedCapabilities = ["model.invoke", "repo.read"];
		if (writes) usedCapabilities.push("repo.write");
		if (r.usedBash) usedCapabilities.push("process.exec");
		usedCapabilities.sort();

		const observations: DependencyObservation[] = dedupeByCanonical([
			{
				kind: "model_runtime",
				locator: `anthropic/${manifest.modelId}`,
				selector_digest: sha256(manifest.modelId),
				observed_digest: sha256(manifest.modelId),
				provenance: "declared",
				capture_method: "tool_wrapper",
				completeness: "complete",
			},
			...preds.get(occId(r))!.map(
				(p): DependencyObservation => ({
					kind: "node_output",
					locator: `node:${occId(p)}`,
					selector_digest: sha256(occId(p)),
					observed_digest: digestOf(p.output ?? p.finalText),
					provenance: "declared",
					capture_method: "tool_wrapper",
					completeness: "complete",
				}),
			),
			...r.observations,
		]);

		const declared = dedupeByCanonical(
			observations
				.filter((o) => o.provenance === "declared")
				.map((o) => ({
					kind: o.kind,
					locator: o.locator,
					selector_digest: o.selector_digest ?? sha256(o.locator),
				})),
		);

		const inputBindings = dedupeByCanonical(
			preds.get(occId(r))!.map((p) => ({
				port: p.nodeId,
				type: "wea/NodeOutput@1",
				artifact_digest: digestOf(p.output ?? p.finalText),
			})),
		);

		const readScope = ["workspace://repo"];
		const writeScope = writes ? ["workspace://repo"] : [];

		return {
			attempt_id: randomUUID(),
			runtime_node: {
				instance_id: instanceId,
				runtime_node_id: r.nodeId,
				generation: r.graphGeneration ?? 0,
				template_node_id: r.nodeId,
			},
			attempt_no: r.attemptNo,
			span_context: { trace_id: manifest.traceId, span_id: newSpanId(), parent_span_id: null },
			input_bindings: inputBindings,
			dependency_manifest: {
				root_digest: digestOf(observations),
				negative_dependency_root: sha256("[]"),
				completeness: "conservative", // Phase 1: no sandbox-grade capture (D10)
				declared,
				observed: observations,
			},
			outputs: [digestOf(r.output ?? r.finalText)],
			cache_decision: {
				requested_mode: "DISABLED",
				final_mode: "DISABLED",
				candidate_artifact_digests: [],
				gate_results: [],
				source_attempt_id: null,
				fallback_reason: null,
			},
			execution: {
				executor_digest: sha256("wea-runner@0.1.0"),
				model_revision: manifest.modelId,
				inference_config_digest: digestOf({ model: manifest.modelId, card: r.agentCard, prompt: r.systemPromptDigest }),
				toolchain_digest: digestOf({ node: process.version, pi: manifest.piVersion }),
				environment_digest: digestOf({ platform: process.platform, arch: process.arch }),
			},
			effects: {
				read_scope: readScope,
				write_scope: writeScope,
				write_semantics: writes ? "idempotent" : "none",
				network_access: "deny",
				external_side_effects: "none",
				determinism: "nondeterministic", // LLM node → replay_policy must not be "safe"
				replay_policy: "verify",
				observed_read_set_root: digestOf(r.readSet),
				observed_write_set_root: digestOf(r.writeSet),
				network_events_root: sha256("[]"),
				undeclared_reads: [],
				undeclared_writes: [],
			},
			permissions_used: {
				capabilities: usedCapabilities,
				filesystem: { read: readScope, write: writeScope },
				network: "deny",
				secrets: [],
			},
			timing: {
				planned_at: r.plannedAt,
				ready_at: r.readyAt,
				started_at: r.startedAt,
				ended_at: r.endedAt,
			},
			cost: {
				input_tokens: r.usage.reduce((a, u) => a + u.input, 0),
				output_tokens: r.usage.reduce((a, u) => a + u.output, 0),
				cached_input_tokens: r.usage.reduce((a, u) => a + u.cachedInput, 0),
				wall_time_ms: Math.max(1, Date.parse(r.endedAt) - Date.parse(r.startedAt)),
				monetary_microunits: r.usage.reduce((a, u) => a + u.costMicrounits, 0),
			},
			status: r.status,
			error: r.error,
		};
	});

	return {
		schema: "wea.trace/v1",
		schema_version: "1.0.0",
		kind: "ExecutionTrace",
		run_id: manifest.runId,
		trace_id: manifest.traceId,
		graph_revision_digest: graphDigest,
		instance_ref: {
			instance_id: instanceId,
			template_release: {
				logical_id: `wea/${manifest.templateId}`,
				template_version: manifest.templateVersion,
				release_digest: releaseDigest,
				spec_digest: specDigest,
			},
			instance_spec_digest: instanceSpecDigest,
		},
		root_task_digest: sha256(manifest.task),
		repo_snapshot_digest: manifest.inputRepoSnapshotDigest ?? repoSnapshotDigest(manifest.repoRoot),
		policy_epoch: 1,
		security_partition: "hmac-sha256:" + sha256("wea-local-dev").slice("sha256:".length),
		started_at: manifest.startedAt,
		ended_at: manifest.endedAt,
		status: manifest.status,
		budget,
		authority: {
			tenant: "local",
			project: "wea-dev",
			classification: "internal",
			allowed_purposes: ["development"],
			permissions_granted: grantedPermissions,
		},
		graph_delta_events: [],
		attempts,
	};
}

// ---- wea.pvf.trace/v1 ----------------------------------------------------------

export function buildPvfTrace(manifest: RunManifest): Record<string, unknown> {
	const preds = executedPredecessors(manifest);
	const critical = criticalPath(manifest, preds);
	const artifactOf = (id: string) => `out:${id}`;

	const occurrences = manifest.records.map((r) => {
		const id = occId(r);
		const wall = Math.max(1, Date.parse(r.endedAt) - Date.parse(r.startedAt));
		return {
			id,
			role: r.kind,
			predecessors: (preds.get(id) ?? []).map(occId),
			output_artifact_ids: [artifactOf(id)],
			cost: {
				input_tokens: r.usage.reduce((a, u) => a + u.input, 0),
				output_tokens: r.usage.reduce((a, u) => a + u.output, 0),
				wall_time_ms: wall,
				critical_path_time_ms: critical.has(id) ? wall : 0,
				dollars: r.usage.reduce((a, u) => a + u.costMicrounits, 0) / 1_000_000,
			},
		};
	});

	const occurrence_edges = manifest.records.flatMap((r) =>
		(preds.get(occId(r)) ?? []).map((p) => ({ source: occId(p), target: occId(r) })),
	);

	const artifacts = manifest.records.map((r) => ({
		id: artifactOf(occId(r)),
		producer: occId(r),
		coverage_weight: 1.0,
	}));

	// Upstream output --derive--> downstream output; verifier outputs also
	// validate what they consumed (their whole point).
	const relations = manifest.records.flatMap((r) =>
		(preds.get(occId(r)) ?? []).map((p) => ({
			source: artifactOf(occId(p)),
			target: artifactOf(occId(r)),
			relation: r.kind === "verifier" ? "validate" : "derive",
		})),
	);

	// Terminal anchors: outputs feeding @output edges. Utility follows the
	// verdict when the node emits one (verifier): pass → 1, anything else → 0
	// (a run that "completed" with verdict fail must not distribute credit).
	const finalGeneration = Math.max(0, ...manifest.records.map((r) => r.graphGeneration ?? 0));
	const finalGraph = graphForGeneration(manifest, finalGeneration);
	const outputNodes = new Set(finalGraph.edges.filter((e) => e.to === "@output").map((e) => e.from));
	const terminal_anchors: { artifact_id: string; utility: number }[] = [];
	for (const r of manifest.records) {
		if ((r.graphGeneration ?? 0) !== finalGeneration || !outputNodes.has(r.nodeId)) continue;
		const laterAttempt = manifest.records.some(
			(o) => (o.graphGeneration ?? 0) === finalGeneration && o.nodeId === r.nodeId && o.attemptNo > r.attemptNo,
		);
		if (laterAttempt || r.status !== "success") continue;
		const verdict = (r.output as Record<string, unknown> | null)?.verdict;
		const utility = verdict === undefined ? 1.0 : verdict === "pass" ? 1.0 : 0.0;
		terminal_anchors.push({ artifact_id: artifactOf(occId(r)), utility });
	}

	return {
		schema: "wea.pvf.trace/v1",
		trace_id: manifest.traceId,
		cost_basis: "tokens",
		default_self_weight: 1.0,
		low_credit_threshold: 0.0,
		occurrences,
		occurrence_edges,
		artifacts,
		relations,
		terminal_anchors,
	};
}
