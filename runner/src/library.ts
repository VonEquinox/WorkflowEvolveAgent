/**
 * Library loader (L3, Phase 1 minimal): reads a workflow template's runner graph
 * from library/templates/<id>.json and its agent cards from library/agents/*.md.
 *
 * The runner graph here is the EXECUTABLE projection (node → agent card + prompt
 * + trigger + edges), intentionally lighter than schemas/workflow-template. The
 * heavyweight typed template/instance documents are a Phase 3 concern; Phase 1
 * only needs enough to drive sessions and emit a validate_ir-passing trace.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentCard } from "./node-session.ts";
import type { WorkflowGraph } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY_ROOT = join(HERE, "..", "..", "library");

export interface RunnerTemplate {
	id: string;
	version: string;
	summary: string;
	graph: WorkflowGraph;
}

export interface LoadedTemplate {
	graph: WorkflowGraph;
	templateVersion: string;
	cards: Map<string, AgentCard>;
}

/** Parse a `---`-fenced YAML-lite frontmatter agent card (subset: scalar + csv). */
export function parseAgentCard(markdown: string): AgentCard {
	const m = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!m) throw new Error("agent card missing frontmatter");
	const [, front, body] = m;
	const meta: Record<string, string> = {};
	for (const line of front!.split("\n")) {
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		const val = line.slice(idx + 1).trim();
		if (key) meta[key] = val;
	}
	if (!meta.name) throw new Error("agent card frontmatter missing 'name'");
	const tools = meta.tools
		? meta.tools.split(",").map((t) => t.trim()).filter(Boolean)
		: undefined;
	return {
		name: meta.name,
		description: meta.description ?? "",
		tools,
		systemPrompt: body!.trim(),
	};
}

export function loadAgentCards(): Map<string, AgentCard> {
	const dir = join(LIBRARY_ROOT, "agents");
	const cards = new Map<string, AgentCard>();
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md")) continue;
		const card = parseAgentCard(readFileSync(join(dir, file), "utf8"));
		cards.set(card.name, card);
	}
	return cards;
}

/**
 * Load a template by id. Accepts a bare id ("t3-complex" → t3-complex.json) or a
 * versioned ref ("t3-complex@1.0.1" → t3-complex@1.0.1.json), so A/B tests can
 * name a specific auto-edited version. The graph's `id` field is always the base
 * id (versions are distinguished by `version`), so we validate against the base.
 */
export function loadTemplate(ref: string): LoadedTemplate {
	const baseId = ref.split("@", 1)[0]!;
	const path = join(LIBRARY_ROOT, "templates", `${ref}.json`);
	const tpl = JSON.parse(readFileSync(path, "utf8")) as RunnerTemplate;
	if (tpl.id !== baseId) throw new Error(`template id mismatch: file says ${tpl.id}, requested base ${baseId}`);
	const cards = loadAgentCards();
	for (const node of tpl.graph.nodes) {
		if (!cards.has(node.agentCard)) throw new Error(`template ${ref} node ${node.id} needs missing card ${node.agentCard}`);
	}
	return { graph: tpl.graph, templateVersion: tpl.version, cards };
}
