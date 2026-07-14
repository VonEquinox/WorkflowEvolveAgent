/**
 * Retrieval (L3, Phase 3 minimal) — pick a workflow template for a task.
 *
 * Given a TaskCard (goal + task family + repo language + available oracle), rank
 * the templates in library/templates/ by a hybrid of:
 *   1. a hard rule router (task family → a preferred template), and
 *   2. BM25 over each template's textual metadata (id, summary, tags derived
 *      from the graph shape: node kinds, whether it fans out, whether it loops).
 *
 * This is deliberately dependency-free and offline: no embeddings, no network.
 * The rule router gives a strong prior for the four cold-start families (T0–T3
 * from v0.2 §8.5); BM25 breaks ties and handles free-text goals. If retrieval
 * has no signal it falls back to the safe generic (T1), never to nothing.
 *
 * CLI:
 *   tsx src/retrieval.ts --goal "fix a failing test" --family bugfix --language js
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerTemplate } from "./library.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(HERE, "..", "..", "library", "templates");

/** What we know about the task before choosing a workflow. */
export interface TaskCard {
	goal: string;
	/** rough task family; drives the rule router. */
	family?: "direct" | "generic" | "bugfix" | "complex" | string;
	language?: string;
	/** is there an automated oracle (tests) we can rely on? */
	hasOracle?: boolean;
}

export interface Candidate {
	id: string;
	version: string;
	summary: string;
	score: number;
	why: string[];
}

/** Rule router: task family → preferred template id (the strong prior). */
const FAMILY_ROUTE: Record<string, string> = {
	direct: "t0-direct",
	generic: "t1-safe-generic",
	bugfix: "t2-bugfix",
	complex: "t3-complex",
};

const RULE_BONUS = 10; // additive; dominates BM25 so a matched family wins ties.
const FALLBACK_ID = "t1-safe-generic";

/** Load only base templates (skip auto-edited `id@version.json` challengers). */
export function loadTemplateCatalog(dir = TEMPLATES_DIR): RunnerTemplate[] {
	const out: RunnerTemplate[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		if (file.includes("@")) continue; // challengers are not catalog entries
		out.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as RunnerTemplate);
	}
	return out;
}

/** A template's searchable text: id + summary + shape-derived tags. */
export function templateDocument(tpl: RunnerTemplate): string {
	const kinds = tpl.graph.nodes.map((n) => n.kind);
	const tags: string[] = [];
	if (kinds.filter((k) => k === "planner").length >= 2) tags.push("parallel", "explore", "fanout");
	if (kinds.includes("aggregator")) tags.push("aggregate", "merge", "fanin");
	if (kinds.includes("verifier")) tags.push("verify", "test", "review");
	if (tpl.graph.loops.length > 0) tags.push("loop", "retry", "fix");
	if (tpl.graph.nodes.length <= 3) tags.push("simple", "small", "direct");
	return `${tpl.id} ${tpl.summary} ${tags.join(" ")}`.toLowerCase();
}

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Minimal BM25 over the template catalog. */
export function bm25Scores(query: string, docs: { id: string; text: string }[]): Map<string, number> {
	const k1 = 1.5;
	const b = 0.75;
	const tokd = docs.map((d) => ({ id: d.id, terms: tokenize(d.text) }));
	const avgLen = tokd.reduce((a, d) => a + d.terms.length, 0) / (tokd.length || 1);
	const df = new Map<string, number>();
	for (const d of tokd) {
		for (const t of new Set(d.terms)) df.set(t, (df.get(t) ?? 0) + 1);
	}
	const N = tokd.length;
	const qTerms = tokenize(query);
	const scores = new Map<string, number>();
	for (const d of tokd) {
		const len = d.terms.length;
		const tf = new Map<string, number>();
		for (const t of d.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
		let s = 0;
		for (const qt of qTerms) {
			const f = tf.get(qt);
			if (!f) continue;
			const n = df.get(qt) ?? 0;
			const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
			s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
		}
		scores.set(d.id, s);
	}
	return scores;
}

/** Rank templates for a TaskCard. Highest score first; never empty. */
export function retrieve(card: TaskCard, catalog = loadTemplateCatalog()): Candidate[] {
	const docs = catalog.map((t) => ({ id: t.id, text: templateDocument(t) }));
	const query = `${card.goal} ${card.family ?? ""} ${card.language ?? ""}`;
	const bm25 = bm25Scores(query, docs);
	const routed = card.family ? FAMILY_ROUTE[card.family] : undefined;

	const candidates: Candidate[] = catalog.map((t) => {
		const why: string[] = [];
		let score = bm25.get(t.id) ?? 0;
		if (score > 0) why.push(`bm25=${score.toFixed(2)}`);
		if (routed && routed === t.id) {
			score += RULE_BONUS;
			why.push(`rule: family '${card.family}' → ${t.id}`);
		}
		// a template with a verifier is preferable when an oracle exists
		if (card.hasOracle && t.graph.nodes.some((n) => n.kind === "verifier")) {
			score += 0.5;
			why.push("oracle available + template verifies");
		}
		return { id: t.id, version: t.version, summary: t.summary, score, why };
	});

	candidates.sort((a, b) => b.score - a.score);
	// fallback: if the top score is 0 (no signal at all), prefer the safe generic.
	if ((candidates[0]?.score ?? 0) === 0) {
		const fb = candidates.find((c) => c.id === FALLBACK_ID);
		if (fb) {
			fb.score = 0.01;
			fb.why.push("no retrieval signal → safe-generic fallback");
			candidates.sort((a, b) => b.score - a.score);
		}
	}
	return candidates;
}

// ---- CLI --------------------------------------------------------------------

function isMain(): boolean {
	return process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
}

if (isMain()) {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const card: TaskCard = {
		goal: get("--goal") ?? "",
		family: get("--family"),
		language: get("--language"),
		hasOracle: argv.includes("--oracle"),
	};
	if (!card.goal && !card.family) {
		console.error('usage: tsx src/retrieval.ts --goal "..." [--family bugfix] [--language js] [--oracle]');
		process.exit(1);
	}
	const ranked = retrieve(card);
	console.log(`TaskCard: ${JSON.stringify(card)}\n`);
	for (const c of ranked) {
		console.log(`${c.score.toFixed(2).padStart(6)}  ${c.id}@${c.version}  — ${c.summary}`);
		for (const w of c.why) console.log(`         · ${w}`);
	}
	console.log(`\n→ chosen: ${ranked[0]!.id}`);
}
