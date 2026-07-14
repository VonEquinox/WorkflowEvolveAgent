/**
 * Pre-run planning (control plane).
 *
 * Default live path when --template auto (or GUI auto):
 *   1. BM25 + rule retrieval ranks the catalog (cheap, offline).
 *   2. WEA control LLM either:
 *        - adapts the best existing template (wea.proposal/v2 edits), or
 *        - cold-starts a brand-new graph when the catalog is a poor fit.
 *   3. Structural gate ensures the graph executes.
 *   4. Worker nodes then run via pi with the user's default pi model.
 *
 * Explicit --template <id> skips the control LLM and runs that graph as-is.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerTemplate } from "./library.ts";
import { loadTemplateCatalog, retrieve, type Candidate, type TaskCard } from "./retrieval.ts";
import {
	applyEditsToGraph,
	applyProposal,
	gateProposal,
	structuralIssuesOfGraph,
	type Proposal,
	type RunnerTemplateDoc,
} from "./template-edit.ts";
import type { WorkflowGraph } from "./types.ts";
import {
	controlComplete,
	parseJsonObject,
	type ControlUsage,
	type WeaControlConfig,
} from "./wea-control.ts";

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "library", "templates");

/** Minimum retrieval score to treat a catalog template as "good enough to adapt". */
export const ADAPT_SCORE_THRESHOLD = 0.5;

export type PlanMode = "use" | "adapt" | "cold_start" | "explicit";

export interface PlanResult {
	mode: PlanMode;
	/** Base family id (t0-direct / t1-… / cold-start-…). */
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
	/** Retrieval ranking (when auto). */
	candidates?: Candidate[];
	/** Raw control decision JSON (debug). */
	decision?: Record<string, unknown>;
}

const PLANNER_SYSTEM = `You are the WEA control-plane planner for a multi-agent coding workflow system.
You do NOT implement the coding task. You only choose / adapt / invent the WORKFLOW GRAPH that
worker agents (running under the user's default pi model) will execute.

You receive:
  - the user task
  - the top retrieval candidates from an existing template catalog (with scores and graph shapes)

Decide ONE of:
  A) "use"        — run the best catalog template unchanged
  B) "adapt"      — start from a catalog template and emit structural edits (wea.proposal/v2)
  C) "cold_start" — catalog is a poor fit; invent a full new graph from scratch

Prefer "adapt" over "cold_start" when a candidate score is decent and only needs small changes
(e.g. tighter prompts, drop a redundant explorer, add a verifier loop).
Use "cold_start" when no candidate is relevant, or the task needs a topology the catalog lacks.
Use "use" when the best candidate already fits well.

Agent cards available to nodes (agentCard field MUST be one of these):
  inspector, explorer, aggregator, implementer, verifier

Node kinds: planner | worker | verifier | aggregator
Triggers: ALL_SUCCESS | ANY_SUCCESS
Edge kinds: DATA | CONTROL | FEEDBACK (FEEDBACK needs loopId)
Ports: @input, @output

OUTPUT: exactly one JSON object (no markdown), one of these shapes:

// A) use
{
  "decision": "use",
  "base_template": "<catalog id>",
  "reasoning": "<why this is already good enough>"
}

// B) adapt
{
  "decision": "adapt",
  "schema": "wea.proposal/v2",
  "target_template": "<catalog id>",
  "target_version": "<version from catalog>",
  "edits": [ /* same ops as meta-improver: remove_node, add_node, edit_prompt, set_model,
               add_edge, remove_edge, set_loop, remove_loop */ ],
  "reasoning": "<why>",
  "hypothesis": "<what should improve>",
  "expected_effect": "<predicted delta>"
}

// C) cold_start
{
  "decision": "cold_start",
  "id": "cold-<short-slug>",
  "version": "1.0.0",
  "summary": "<one line>",
  "reasoning": "<why inventing a new graph>",
  "graph": {
    "nodes": [
      {
        "id": "<unique>",
        "kind": "planner|worker|verifier|aggregator",
        "agentCard": "inspector|explorer|aggregator|implementer|verifier",
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
  - omit per-node "model" fields (workers use the user's default pi model)`;

export interface PlanOptions {
	task: string;
	family?: string;
	language?: string;
	/** When set, skip LLM planning and just load this template. */
	explicitTemplate?: string;
	control?: WeaControlConfig | null;
	/** Persist adapted / cold-start graphs under library/templates. Default true when control is used. */
	persist?: boolean;
	/** Offline: never call control LLM; just retrieval (+ champion is applied by caller if desired). */
	offline?: boolean;
	/** Score below this → prefer cold_start when control LLM is available. */
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

function materializePath(id: string, version: string, isCold: boolean): string {
	// cold-start: new base file; adapt: versioned challenger (never clobber catalog bases).
	const name = isCold ? `${id}.json` : `${id}@${version}.json`;
	return join(TEMPLATES_DIR, name);
}

function writeTemplateDoc(doc: RunnerTemplateDoc, path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

/**
 * Offline / no-control fallback: pure retrieval, run best (or safe generic) as-is.
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
		why: `offline retrieval → ${top.id} (score ${top.score.toFixed(2)}; ${top.why.join("; ") || "fallback"})`,
		graph: doc.graph,
		controlUsage: zeroUsage(),
		candidates: ranked,
	};
}

/**
 * Main planner. When control config is present and template is auto, calls WEA model.
 */
export async function planWorkflow(opts: PlanOptions): Promise<PlanResult> {
	const log = opts.onLog ?? (() => {});
	const threshold = opts.adaptThreshold ?? ADAPT_SCORE_THRESHOLD;

	if (opts.explicitTemplate && opts.explicitTemplate !== "auto") {
		const catalog = loadTemplateCatalog();
		// Support versioned refs: try catalog base first, else load via library path in caller.
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
			graph: { nodes: [], edges: [], loops: [] }, // placeholder; orchestrator loads real graph
			controlUsage: zeroUsage(),
		};
	}

	if (opts.offline || !opts.control) {
		return planOffline(opts);
	}

	const card: TaskCard = {
		goal: opts.task,
		family: opts.family,
		language: opts.language,
		hasOracle: true,
	};
	const ranked = retrieve(card);
	const catalog = loadTemplateCatalog();
	const top = ranked[0]!;
	log(`[plan] retrieval top=${top.id} score=${top.score.toFixed(2)}`);

	const catalogBrief = ranked.slice(0, 4).map((c) => {
		const doc = catalog.find((t) => t.id === c.id)!;
		return {
			id: c.id,
			version: c.version,
			score: c.score,
			why: c.why,
			summary: c.summary,
			graph: doc.graph,
		};
	});

	const user = [
		"## Task",
		opts.task,
		"",
		"## TaskCard",
		JSON.stringify({ family: opts.family ?? null, language: opts.language ?? null, hasOracle: true }),
		"",
		`## Retrieval ranking (threshold for "good fit" ≈ ${threshold})`,
		JSON.stringify(catalogBrief, null, 2),
		"",
		"Emit the decision JSON now.",
	].join("\n");

	const completion = await controlComplete(opts.control, {
		system: PLANNER_SYSTEM,
		user,
		maxTokens: 4096,
		temperature: 0.2,
	});
	const usage = completion.usage;
	const decision = parseJsonObject(completion.text);
	if (!decision) {
		log("[plan] control LLM returned unparseable JSON; falling back to offline retrieval");
		const fb = planOffline(opts);
		return { ...fb, controlUsage: usage, why: `${fb.why} (control parse fail fallback)` };
	}

	const kind = String(decision.decision ?? "").toLowerCase();
	log(`[plan] control decision=${kind}`);

	// ---- use ----
	if (kind === "use") {
		const id = String(decision.base_template ?? top.id);
		const doc = catalogDoc(id, catalog);
		return {
			mode: "use",
			baseId: doc.id,
			version: doc.version,
			why: `control:use ${doc.id} — ${String(decision.reasoning ?? "").slice(0, 200)}`,
			graph: doc.graph,
			controlUsage: usage,
			candidates: ranked,
			decision,
		};
	}

	// ---- adapt ----
	if (kind === "adapt") {
		const proposal = decision as unknown as Proposal;
		if (proposal.schema !== "wea.proposal/v2") {
			// tolerate missing schema tag
			(proposal as any).schema = "wea.proposal/v2";
		}
		const target = String(proposal.target_template || top.id);
		const doc = catalogDoc(target, catalog);
		proposal.target_template = doc.id;
		proposal.target_version = doc.version;
		if (!Array.isArray(proposal.edits)) proposal.edits = [];

		if (proposal.edits.length === 0) {
			return {
				mode: "use",
				baseId: doc.id,
				version: doc.version,
				why: `control:adapt with empty edits → use ${doc.id}`,
				graph: doc.graph,
				controlUsage: usage,
				candidates: ranked,
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
				why: `control:adapt rejected by structural gate (${gate.violations.join("; ")}) → use ${doc.id}`,
				graph: doc.graph,
				controlUsage: usage,
				candidates: ranked,
				decision,
			};
		}

		const next = applyProposal(doc, proposal);
		// Strip per-node models so workers always use pi default.
		for (const n of next.graph.nodes) delete n.model;

		let writtenPath: string | undefined;
		if (opts.persist !== false) {
			writtenPath = materializePath(next.id, next.version, false);
			writeTemplateDoc(next, writtenPath);
			log(`[plan] wrote adapted template ${writtenPath}`);
		}

		return {
			mode: "adapt",
			baseId: next.id,
			version: next.version,
			why: `control:adapt ${doc.id} → v${next.version} (${proposal.edits.map((e) => e.op).join(", ")})`,
			graph: next.graph,
			writtenPath,
			controlUsage: usage,
			candidates: ranked,
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

		const doc: RunnerTemplateDoc = { id, version, summary, graph };
		let writtenPath: string | undefined;
		if (opts.persist !== false) {
			writtenPath = materializePath(id, version, true);
			writeTemplateDoc(doc, writtenPath);
			log(`[plan] wrote cold-start template ${writtenPath}`);
		}

		return {
			mode: "cold_start",
			baseId: id,
			version,
			why: `control:cold_start ${id} — ${String(decision.reasoning ?? "").slice(0, 200)}`,
			graph,
			writtenPath,
			controlUsage: usage,
			candidates: ranked,
			decision,
		};
	}

	// Unknown decision → offline
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

/** Re-export graph clone helper used by tests. */
export function cloneGraph(g: WorkflowGraph): WorkflowGraph {
	return structuredClone(g);
}

// silence unused import if tree-shaken oddly
void applyEditsToGraph;
