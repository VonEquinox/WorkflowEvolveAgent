/** GUI-facing workflow-template listing, validation, and immutable publication. */

import { readdirSync } from "node:fs";
import { basename } from "node:path";
import {
	loadAgentCards,
	loadTemplateDocument,
	TEMPLATES_DIR,
	type RunnerTemplate,
	validateTemplateRef,
} from "./library.ts";
import { validateWorkflowGraph } from "./schemas.ts";
import { bumpPatch, parseSemver, publishBaseTemplate, publishExactVersionedTemplate } from "./template-store.ts";
import type { RunnerTemplateDoc } from "./template-edit.ts";
import type { WorkflowGraph, WorkflowTemplateUi } from "./types.ts";

const ID_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export interface ListedTemplate extends RunnerTemplate {
	ref: string;
	isBase: boolean;
	isLatest: boolean;
	validationErrors: string[];
}

export type TemplateSaveRequest =
	| {
			operation: "create";
			id: string;
			summary: string;
			graph: WorkflowGraph;
			ui?: WorkflowTemplateUi;
	  }
	| {
			operation: "revise";
			sourceRef: string;
			sourceVersion: string;
			summary: string;
			graph: WorkflowGraph;
			ui?: WorkflowTemplateUi;
	  };

export interface TemplateSaveResult {
	template: ListedTemplate;
	path: string;
}

export class TemplateRequestError extends Error {
	constructor(message: string, readonly status: 400 | 404 | 409 = 400, readonly errors: string[] = []) {
		super(message);
		this.name = "TemplateRequestError";
	}
}

function compareSemver(a: string, b: string): number {
	const av = parseSemver(a);
	const bv = parseSemver(b);
	for (let i = 0; i < 3; i += 1) {
		if (av[i]! !== bv[i]!) return av[i]! - bv[i]!;
	}
	return 0;
}

function validateUi(ui: unknown, graph: WorkflowGraph): string[] {
	if (ui === undefined) return [];
	if (!ui || typeof ui !== "object" || Array.isArray(ui)) return ["ui must be an object"];
	const uiKeys = Object.keys(ui as Record<string, unknown>);
	if (uiKeys.some((key) => key !== "positions")) return ["ui may only contain positions"];
	const positions = (ui as any).positions;
	if (!positions || typeof positions !== "object" || Array.isArray(positions)) {
		return ["ui.positions must be an object"];
	}
	const nodeIds = new Set(graph.nodes.map((node) => node.id));
	const errors: string[] = [];
	for (const [nodeId, raw] of Object.entries(positions)) {
		if (!nodeIds.has(nodeId)) errors.push(`ui position references unknown node ${nodeId}`);
		const point = raw as any;
		if (
			!point || typeof point !== "object" || Array.isArray(point) ||
			Object.keys(point).some((key) => key !== "x" && key !== "y") ||
			!Number.isFinite(point.x) || !Number.isFinite(point.y)
		) {
			errors.push(`ui position for ${nodeId} must contain finite x/y numbers`);
		}
	}
	return errors;
}

export function validateEditableGraph(
	graph: unknown,
	ui?: unknown,
	allowedAgentCards: ReadonlySet<string> = new Set(loadAgentCards().keys()),
): { ok: boolean; errors: string[] } {
	const graphResult = validateWorkflowGraph(graph, { allowedAgentCards });
	const uiErrors = graphResult.ok ? validateUi(ui, graphResult.value!) : [];
	const errors = [...graphResult.errors, ...uiErrors];
	return { ok: errors.length === 0, errors };
}

export function listTemplateDocuments(
	dir = TEMPLATES_DIR,
	allowedAgentCards: ReadonlySet<string> = new Set(loadAgentCards().keys()),
): ListedTemplate[] {
	const docs: Array<{ ref: string; isBase: boolean; doc: RunnerTemplate; validationErrors: string[] }> = [];
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".json") || file.endsWith(".champion.json")) continue;
		const ref = basename(file, ".json");
		try {
			validateTemplateRef(ref);
			const doc = loadTemplateDocument(ref, dir);
			const validation = validateEditableGraph(doc.graph, doc.ui, allowedAgentCards);
			docs.push({ ref, isBase: !ref.includes("@"), doc, validationErrors: validation.errors });
		} catch {
			// Non-template JSON files are not part of the editor surface.
		}
	}
	const latestById = new Map<string, string>();
	for (const item of docs) {
		const current = latestById.get(item.doc.id);
		if (!current || compareSemver(item.doc.version, current) > 0) latestById.set(item.doc.id, item.doc.version);
	}
	return docs
		.map(({ ref, isBase, doc, validationErrors }) => ({
			...doc,
			ref,
			isBase,
			isLatest: latestById.get(doc.id) === doc.version,
			validationErrors,
		}))
		.sort((a, b) => a.id.localeCompare(b.id) || compareSemver(a.version, b.version));
}

function normalizeSummary(value: unknown): string {
	const summary = typeof value === "string" ? value.trim() : "";
	if (!summary) throw new TemplateRequestError("summary is required");
	if (summary.length > 2_000) throw new TemplateRequestError("summary must be at most 2000 characters");
	return summary;
}

function validateForSave(graph: unknown, ui: unknown, allowedAgentCards: ReadonlySet<string>): WorkflowGraph {
	const validation = validateEditableGraph(graph, ui, allowedAgentCards);
	if (!validation.ok) throw new TemplateRequestError("workflow graph is invalid", 400, validation.errors);
	return structuredClone(graph as WorkflowGraph);
}

export function saveTemplateDocument(
	request: TemplateSaveRequest,
	opts: { dir?: string; allowedAgentCards?: ReadonlySet<string> } = {},
): TemplateSaveResult {
	const dir = opts.dir ?? TEMPLATES_DIR;
	const allowedAgentCards = opts.allowedAgentCards ?? new Set(loadAgentCards().keys());
	if (!request || typeof request !== "object") throw new TemplateRequestError("request body must be an object");
	const summary = normalizeSummary((request as any).summary);
	const graph = validateForSave((request as any).graph, (request as any).ui, allowedAgentCards);
	const ui = (request as any).ui === undefined ? undefined : structuredClone((request as any).ui as WorkflowTemplateUi);

	let published: { doc: RunnerTemplateDoc; path: string };
	if (request.operation === "create") {
		const id = typeof request.id === "string" ? request.id.trim() : "";
		if (!ID_RE.test(id)) throw new TemplateRequestError("id must match ^[A-Za-z][A-Za-z0-9_.-]{0,63}$");
		published = publishBaseTemplate({ id, version: "1.0.0", summary, graph, ui }, dir);
	} else if (request.operation === "revise") {
		try {
			validateTemplateRef(request.sourceRef);
		} catch (err) {
			throw new TemplateRequestError(String((err as Error).message));
		}
		let source: RunnerTemplate;
		try {
			source = loadTemplateDocument(request.sourceRef, dir);
		} catch (err: any) {
			if (err?.code === "ENOENT") throw new TemplateRequestError(`source template ${request.sourceRef} does not exist`, 404);
			throw err;
		}
		if (request.sourceVersion !== source.version) {
			throw new TemplateRequestError(
				`source version mismatch: request=${request.sourceVersion}, file=${source.version}`,
				409,
			);
		}
		const latest = listTemplateDocuments(dir, allowedAgentCards)
			.filter((item) => item.id === source.id)
			.sort((a, b) => compareSemver(b.version, a.version))[0];
		if (!latest || latest.version !== source.version) {
			throw new TemplateRequestError(
				`stale template revision: ${request.sourceRef} (version ${source.version}); latest is ${latest?.ref ?? "unknown"}`,
				409,
			);
		}
		const next: RunnerTemplateDoc = {
			id: source.id,
			version: bumpPatch(source.version),
			summary,
			catalog: source.catalog,
			graph,
			ui,
		};
		try {
			published = publishExactVersionedTemplate(next, dir);
		} catch (err: any) {
			if (err?.code === "EEXIST") throw new TemplateRequestError(`template ${next.id}@${next.version} already exists`, 409);
			throw err;
		}
	} else {
		throw new TemplateRequestError("operation must be create or revise");
	}

	const ref = published.path.endsWith(`${published.doc.id}.json`)
		? published.doc.id
		: `${published.doc.id}@${published.doc.version}`;
	const listed = listTemplateDocuments(dir, allowedAgentCards).find((item) => item.ref === ref);
	if (!listed) throw new Error(`published template ${ref} could not be reloaded`);
	return { template: listed, path: published.path };
}
