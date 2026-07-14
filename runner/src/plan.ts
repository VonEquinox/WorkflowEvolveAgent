/**
 * Pre-run planning (control plane).
 *
 * Default live path when --template auto (or GUI auto):
 *   1. Load the FULL template catalog (no offline ranking as the decision).
 *   2. Call the WEA control LLM (WEA_* API) to judge the task and decide:
 *        - use        — pick a catalog template unchanged
 *        - adapt      — edit a catalog template (wea.proposal/v2)
 *        - cold_start — invent a new graph when nothing fits
 *   3. Structural gate ensures the graph executes.
 *   4. Worker nodes then run via pi with the user's default pi model.
 *
 * Offline BM25 retrieval is ONLY a fallback when control is unavailable
 * (--offline-plan / sim / missing WEA_*), not the live router.
 *
 * Explicit --template <id> skips the control LLM and runs that graph as-is.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerTemplate } from "./library.ts";
import { loadTemplateCatalog, retrieve, type Candidate, type TaskCard } from "./retrieval.ts";
import {
	applyProposal,
	gateProposal,
	structuralIssuesOfGraph,
	type Proposal,
	type RunnerTemplateDoc,
} from "./template-edit.ts";
import type { WorkflowGraph } from "./types.ts";
import { publishBaseTemplate, publishVersionedTemplate } from "./template-store.ts";
import { CONTROL_PLANE_IDENTITY } from "./control-identity.ts";
import {
	controlComplete,
	parseJsonObject,
	type ControlUsage,
	type WeaControlConfig,
} from "./wea-control.ts";

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "library", "templates");

export type PlanMode = "use" | "adapt" | "cold_start" | "explicit";

export interface PlanResult {
	mode: PlanMode;
	/** Base family id (t0-direct / t1-… / cold-…). */
	baseId: string;
	/** Version string on the graph that will run. */
	version: string;
	/** Human-readable resolution story. */
	why: string;
	/** Graph after adapt / cold-start / load. */
	graph: WorkflowGraph;
	/** Optional path if we materialised a challenger / cold-start file. */
	writtenPath?: string;
	/** Control-plane token usage (0 if offline / explicit / skipped). */
	controlUsage: ControlUsage;
	/** Offline retrieval ranking only (fallback path). */
	candidates?: Candidate[];
	/** Raw control decision JSON (debug). */
	decision?: Record<string, unknown>;
}

const PLANNER_SYSTEM = `${CONTROL_PLANE_IDENTITY}
You are the WEA **pre-run graph planner / router** for a multi-agent coding workflow system.

You are the ONLY router. There is no offline scorer making decisions for you.
You receive the full user task and the complete catalog of existing workflow templates
(with their graphs). YOU classify the task (bugfix vs feature vs refactor vs research vs …)
and YOU choose how workers should be orchestrated.

You do NOT implement the coding task yourself. Weaker pi workers execute the graph.
If the task is complex, **you** own the hard planning by choosing a topology that
puts recon on workers and planning/handoff on control (e.g. t-explore-master-implement
or t3-complex), not by hoping implementer figures out the architecture alone.

Decide ONE of:
  A) "use"        — pick one catalog template and run it unchanged
  B) "adapt"      — start from one catalog template and emit structural edits (wea.proposal/v2)
  C) "cold_start" — catalog is a poor fit; invent a full new graph from scratch

Classification guidance (you decide; these are hints, not rules):
  - failing test / off-by-one / crash / regression → prefer t-bugfix-master
    (localize → YOU handoff) or classic t2-bugfix if no mid-run master needed
  - small direct change with clear acceptance → often t0-direct or t1-safe-generic
  - non-trivial change that needs recon then strong plan → t-read-master
    (inspector read → YOU handoff) — default strong path for most engineering work
  - feature / API enhancement → t-feature-master (pattern inspect → handoff)
  - refactor / rename / extract → t-refactor-master (impact analysis → handoff)
  - multi-approach design / large unclear exploration → t-explore-master-implement
    or t3-complex (worker-only aggregate if you do not need mid-run master)
  - dual-angle review / audit → t-review-master
  - test coverage / harness / flaky tests → t-test-master
  - incident / outage / stacktrace → t-incident-master
  - migrate / upgrade / deprecation → t-migrate-master
  - documentation grounded in code → t-docs-master
  - architecture / multi-file design → handoff-style graphs (read/explore then master)
  - nothing fits topology → cold_start a small custom graph (you may include a
    master-handoff node with controlHandoff:true AFTER read/explore nodes)

Prefer "use" when a catalog graph already fits.
Prefer "adapt" for small prompt/topology tweaks (drop redundant node, tighten prompts, add loop).
Use "cold_start" only when no catalog template is a reasonable base.

Handoff family (preferred for hard work):
  Workers READ first (inspector/explorer only — no write tools). Then a node with
  agentCard "master-handoff" and controlHandoff:true returns control to YOU mid-graph.
  You synthesize master_plan and dispatch a code-edit subgraph (implement→verify or
  patch→regression). Stage subgraphs t-implement-verify / t-patch-regression are
  catalog:false (not ranked offline) but loadable by id / as handoff defaults.

Agent cards available to nodes (agentCard field MUST be one of these):
  inspector, explorer, aggregator, implementer, verifier, master-handoff

Node kinds: planner | worker | verifier | aggregator
Triggers: ALL_SUCCESS | ANY_SUCCESS
Edge kinds: DATA | CONTROL | FEEDBACK (FEEDBACK needs loopId)
Ports: @input, @output

OUTPUT: exactly one JSON object (no markdown), one of these shapes:

// A) use
{
  "decision": "use",
  "task_kind": "bugfix|feature|refactor|research|other",
  "base_template": "<catalog id>",
  "reasoning": "<why this template fits this task>"
}

// B) adapt
{
  "decision": "adapt",
  "task_kind": "bugfix|feature|refactor|research|other",
  "schema": "wea.proposal/v2",
  "target_template": "<catalog id>",
  "target_version": "<version from catalog>",
  "edits": [ /* remove_node | add_node | edit_prompt | set_model |
               add_edge | remove_edge | set_loop | remove_loop */ ],
  "reasoning": "<why>",
  "hypothesis": "<what should improve>",
  "expected_effect": "<predicted delta>"
}

// C) cold_start
{
  "decision": "cold_start",
  "task_kind": "bugfix|feature|refactor|research|other",
  "id": "cold-<short-slug>",
  "version": "1.0.0",
  "summary": "<one line>",
  "reasoning": "<why inventing a new graph>",
  "graph": {
    "nodes": [
      {
        "id": "<unique>",
        "kind": "planner|worker|verifier|aggregator",
        "agentCard": "inspector|explorer|aggregator|implementer|verifier|master-handoff",
        "trigger": "ALL_SUCCESS|ANY_SUCCESS",
        "promptTemplate": "Task:\\n\${task}\\n\\n... may use \${upstream}"
      }
    ],
    "edges": [
      { "id": "e1", "from": "@input", "to": "<node>", "kind": "DATA" },
      { "id": "e2", "from": "<node>", "to": "@output", "kind": "DATA" }
    ],
    "loops": []
  }
}

Rules for graphs you emit (adapt edits or cold_start):
  - every node needs ≥1 non-FEEDBACK incoming edge
  - @input must reach @output on non-FEEDBACK edges
  - no cycles outside declared FEEDBACK loops
  - FEEDBACK edges must set loopId and appear in a loop's feedbackEdges
  - keep graphs small (2–6 nodes) unless the task truly needs more
  - do NOT put absolute paths or secrets in prompts
  - omit per-node "model" fields (workers use the user's default pi model)
  - base_template / target_template MUST be an id present in the catalog when using use/adapt`;

export interface PlanOptions {
	task: string;
	family?: string;
	language?: string;
	/** When set, skip LLM planning and just load this template. */
	explicitTemplate?: string;
	control?: WeaControlConfig | null;
	/** Persist adapted / cold-start graphs under library/templates. Default true when control is used. */
	persist?: boolean;
	/** Offline: never call control LLM; BM25 fallback only. */
	offline?: boolean;
	/** @deprecated ignored — control plane owns the decision; kept for API compat. */
	adaptThreshold?: number;
	onLog?: (msg: string) => void;
}

function zeroUsage(): ControlUsage {
	return { inputTokens: 0, outputTokens: 0 };
}

function catalogDoc(id: string, catalog: RunnerTemplate[]): RunnerTemplateDoc {
	const t = catalog.find((c) => c.id === id);
	if (!t) throw new Error(`unknown catalog template ${id}`);
	return { id: t.id, version: t.version, summary: t.summary, graph: structuredClone(t.graph) };
}

/** Full catalog brief for the control LLM (no scores — model judges). */
function catalogBriefForControl(catalog: RunnerTemplate[]) {
	return catalog.map((t) => ({
		id: t.id,
		version: t.version,
		summary: t.summary,
		graph: t.graph,
	}));
}

/**
 * Offline / no-control fallback ONLY (sim, --offline-plan, missing WEA_*).
 * Live auto path must not rely on this.
 */
export function planOffline(opts: PlanOptions): PlanResult {
	const card: TaskCard = {
		goal: opts.task,
		family: opts.family,
		language: opts.language,
		hasOracle: true,
	};
	const ranked = retrieve(card);
	const top = ranked[0]!;
	const catalog = loadTemplateCatalog();
	const doc = catalogDoc(top.id, catalog);
	return {
		mode: "use",
		baseId: doc.id,
		version: doc.version,
		why: `offline fallback retrieval → ${top.id} (score ${top.score.toFixed(2)}; ${top.why.join("; ") || "fallback"})`,
		graph: doc.graph,
		controlUsage: zeroUsage(),
		candidates: ranked,
	};
}

/**
 * Main planner. Live auto → WEA control API owns classification + template choice.
 */
export async function planWorkflow(opts: PlanOptions): Promise<PlanResult> {
	const log = opts.onLog ?? (() => {});

	if (opts.explicitTemplate && opts.explicitTemplate !== "auto") {
		const catalog = loadTemplateCatalog();
		const baseId = opts.explicitTemplate.split("@", 1)[0]!;
		const fromCatalog = catalog.find((c) => c.id === baseId);
		if (fromCatalog && !opts.explicitTemplate.includes("@")) {
			return {
				mode: "explicit",
				baseId: fromCatalog.id,
				version: fromCatalog.version,
				why: `explicit template ${fromCatalog.id}`,
				graph: structuredClone(fromCatalog.graph),
				controlUsage: zeroUsage(),
			};
		}
		// Versioned / non-base: signal caller to load via loadTemplate(ref)
		return {
			mode: "explicit",
			baseId: opts.explicitTemplate,
			version: "?",
			why: `explicit template ref ${opts.explicitTemplate}`,
			graph: { nodes: [], edges: [], loops: [] },
			controlUsage: zeroUsage(),
		};
	}

	if (opts.offline || !opts.control) {
		log("[plan] no WEA control config — offline BM25 fallback only");
		return planOffline(opts);
	}

	const catalog = loadTemplateCatalog();
	if (catalog.length === 0) throw new Error("template catalog is empty");

	log(`[plan] control-plane routing via ${opts.control.modelId} (${catalog.length} catalog templates, no offline ranker)`);

	const user = [
		"## Task (classify and route this yourself)",
		opts.task,
		"",
		"## Optional hints from the user (may be empty — do not require them)",
		JSON.stringify({
			family_hint: opts.family ?? null,
			language_hint: opts.language ?? null,
		}),
		"",
		"## Full workflow template catalog",
		"Pick from these ids for use/adapt, or cold_start if none fit.",
		JSON.stringify(catalogBriefForControl(catalog), null, 2),
		"",
		"Emit the decision JSON now. You are the only router.",
	].join("\n");

	let completion;
	try {
		completion = await controlComplete(opts.control, {
			system: PLANNER_SYSTEM,
			user,
			maxTokens: 4096,
			temperature: 0.2,
		});
	} catch (err) {
		log(`[plan] control request failed: ${String((err as Error).message)}; falling back to offline retrieval`);
		const fb = planOffline(opts);
		return { ...fb, why: `${fb.why} (control request failed)` };
	}
	const usage = completion.usage;
	const decision = parseJsonObject(completion.text);
	if (!decision) {
		log("[plan] control LLM returned unparseable JSON; falling back to offline retrieval");
		const fb = planOffline(opts);
		return { ...fb, controlUsage: usage, why: `${fb.why} (control parse fail fallback)` };
	}

	const kind = String(decision.decision ?? "").toLowerCase();
	const taskKind = decision.task_kind ? String(decision.task_kind) : "?";
	log(`[plan] control decision=${kind} task_kind=${taskKind}`);

	// ---- use ----
	if (kind === "use") {
		const id = String(decision.base_template ?? "");
		if (!id || !catalog.some((c) => c.id === id)) {
			log(`[plan] control chose unknown template "${id}"; offline fallback`);
			const fb = planOffline(opts);
			return { ...fb, controlUsage: usage, why: `${fb.why} (unknown base_template)` };
		}
		const doc = catalogDoc(id, catalog);
		return {
			mode: "use",
			baseId: doc.id,
			version: doc.version,
			why: `control:use ${doc.id} [${taskKind}] — ${String(decision.reasoning ?? "").slice(0, 200)}`,
			graph: doc.graph,
			controlUsage: usage,
			decision,
		};
	}

	// ---- adapt ----
	if (kind === "adapt") {
		const proposal = decision as unknown as Proposal;
		if (proposal.schema !== "wea.proposal/v2") {
			log(`[plan] adapt proposal has invalid schema ${JSON.stringify(proposal.schema)}; offline fallback`);
			const fb = planOffline(opts);
			return { ...fb, controlUsage: usage, why: `${fb.why} (invalid adapt proposal schema)` };
		}
		const target = String(proposal.target_template || "");
		if (!target || !catalog.some((c) => c.id === target)) {
			log(`[plan] adapt target unknown "${target}"; offline fallback`);
			const fb = planOffline(opts);
			return { ...fb, controlUsage: usage, why: `${fb.why} (unknown adapt target)` };
		}
		const doc = catalogDoc(target, catalog);
		if (proposal.target_version !== doc.version) {
			log(`[plan] adapt version mismatch: proposal=${proposal.target_version ?? "(missing)"}, current=${doc.version}; using ${doc.id} unchanged`);
			return {
				mode: "use",
				baseId: doc.id,
				version: doc.version,
				why: `control:adapt [${taskKind}] rejected stale target version → use ${doc.id}`,
				graph: doc.graph,
				controlUsage: usage,
				decision,
			};
		}
		if (!Array.isArray(proposal.edits)) proposal.edits = [];

		if (proposal.edits.length === 0) {
			return {
				mode: "use",
				baseId: doc.id,
				version: doc.version,
				why: `control:adapt [${taskKind}] empty edits → use ${doc.id}`,
				graph: doc.graph,
				controlUsage: usage,
				decision,
			};
		}

		const gate = gateProposal(doc, proposal);
		if (!gate.ok) {
			log(`[plan] adapt gate failed: ${gate.violations.join("; ")}; using ${doc.id} unchanged`);
			return {
				mode: "use",
				baseId: doc.id,
				version: doc.version,
				why: `control:adapt [${taskKind}] rejected by structural gate (${gate.violations.join("; ")}) → use ${doc.id}`,
				graph: doc.graph,
				controlUsage: usage,
				decision,
			};
		}

		let next = applyProposal(doc, proposal);
		for (const n of next.graph.nodes) delete n.model;

		let writtenPath: string | undefined;
		if (opts.persist !== false) {
			const published = publishVersionedTemplate(next, TEMPLATES_DIR);
			next = published.doc;
			writtenPath = published.path;
			log(`[plan] wrote immutable adapted template ${writtenPath}`);
		}

		return {
			mode: "adapt",
			baseId: next.id,
			version: next.version,
			why: `control:adapt [${taskKind}] ${doc.id} → v${next.version} (${proposal.edits.map((e) => e.op).join(", ")})`,
			graph: next.graph,
			writtenPath,
			controlUsage: usage,
			decision,
		};
	}

	// ---- cold_start ----
	if (kind === "cold_start") {
		const idRaw = String(decision.id ?? "cold-start").replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
		const id = idRaw.startsWith("cold") ? idRaw : `cold-${idRaw}`;
		const version = String(decision.version ?? "1.0.0");
		const summary = String(decision.summary ?? `Cold-start for: ${opts.task.slice(0, 80)}`);
		const graph = decision.graph as WorkflowGraph | undefined;
		if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
			log("[plan] cold_start missing graph; fallback offline");
			const fb = planOffline(opts);
			return { ...fb, controlUsage: usage, why: `${fb.why} (cold_start invalid graph)` };
		}
		if (!Array.isArray(graph.loops)) graph.loops = [];
		for (const n of graph.nodes) delete (n as any).model;

		const issues = structuralIssuesOfGraph(graph);
		if (issues.length) {
			log(`[plan] cold_start structural issues: ${issues.join("; ")}; fallback offline`);
			const fb = planOffline(opts);
			return { ...fb, controlUsage: usage, why: `${fb.why} (cold_start not runnable: ${issues[0]})` };
		}

		let doc: RunnerTemplateDoc = { id, version, summary, graph };
		let writtenPath: string | undefined;
		if (opts.persist !== false) {
			const published = publishBaseTemplate(doc, TEMPLATES_DIR);
			doc = published.doc;
			writtenPath = published.path;
			log(`[plan] wrote immutable cold-start template ${writtenPath}`);
		}

		return {
			mode: "cold_start",
			baseId: doc.id,
			version: doc.version,
			why: `control:cold_start [${taskKind}] ${doc.id} — ${String(decision.reasoning ?? "").slice(0, 200)}`,
			graph: doc.graph,
			writtenPath,
			controlUsage: usage,
			decision,
		};
	}

	log(`[plan] unknown decision "${kind}"; offline fallback`);
	const fb = planOffline(opts);
	return { ...fb, controlUsage: usage, why: `${fb.why} (unknown decision fallback)` };
}

/** Apply a known-good proposal offline (tests). */
export function adaptTemplateLocally(template: RunnerTemplateDoc, proposal: Proposal): RunnerTemplateDoc {
	const next = applyProposal(template, proposal);
	for (const n of next.graph.nodes) delete n.model;
	return next;
}

export function cloneGraph(g: WorkflowGraph): WorkflowGraph {
	return structuredClone(g);
}
