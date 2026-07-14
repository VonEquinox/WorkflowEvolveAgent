/**
 * Runtime JSON-Schema contracts for workflow graphs, proposals, and agent outputs.
 *
 * TypeScript interfaces disappear at runtime; every graph or JSON object that can
 * originate from an LLM or a template file must pass these validators before it
 * can affect scheduling or run success.
 */

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { NodeOutput, WorkflowGraph } from "./types.ts";

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
const ID_PATTERN = "^[A-Za-z][A-Za-z0-9_.-]{0,63}$";

const budgetSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		maxTokens: { type: "integer", minimum: 1 },
		maxMonetaryMicrounits: { type: "integer", minimum: 0 },
		maxWallTimeMs: { type: "integer", minimum: 1 },
	},
} as const;

export const WORKFLOW_GRAPH_JSON_SCHEMA = {
	$id: "wea.workflow-graph/v1",
	type: "object",
	additionalProperties: false,
	required: ["nodes", "edges", "loops"],
	properties: {
		nodes: {
			type: "array",
			minItems: 1,
			maxItems: 64,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "kind", "agentCard", "trigger", "promptTemplate"],
				properties: {
					id: { type: "string", pattern: ID_PATTERN },
					kind: { enum: ["planner", "worker", "verifier", "aggregator"] },
					agentCard: { type: "string", pattern: ID_PATTERN },
					trigger: { enum: ["ALL_SUCCESS", "ANY_SUCCESS"] },
					promptTemplate: { type: "string", minLength: 1, maxLength: 100_000 },
					model: { type: "string", minLength: 1 },
					controlHandoff: { type: "boolean" },
					budget: budgetSchema,
				},
			},
		},
		edges: {
			type: "array",
			minItems: 1,
			maxItems: 256,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "from", "to", "kind"],
				properties: {
					id: { type: "string", pattern: ID_PATTERN },
					from: { type: "string", minLength: 1, maxLength: 65 },
					to: { type: "string", minLength: 1, maxLength: 65 },
					kind: { enum: ["DATA", "CONTROL", "FEEDBACK"] },
					loopId: { type: ["string", "null"], pattern: ID_PATTERN },
				},
			},
		},
		loops: {
			type: "array",
			maxItems: 32,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "bodyNodes", "feedbackEdges", "maxIterations"],
				properties: {
					id: { type: "string", pattern: ID_PATTERN },
					bodyNodes: {
						type: "array",
						minItems: 1,
						uniqueItems: true,
						items: { type: "string", pattern: ID_PATTERN },
					},
					feedbackEdges: {
						type: "array",
						minItems: 1,
						uniqueItems: true,
						items: { type: "string", pattern: ID_PATTERN },
					},
					maxIterations: { type: "integer", minimum: 1, maximum: 20 },
				},
			},
		},
	},
} as const;

const graphShapeValidator = ajv.compile(WORKFLOW_GRAPH_JSON_SCHEMA);

export interface GraphValidationOptions {
	allowedAgentCards?: ReadonlySet<string>;
}

export interface ValidationResult<T = unknown> {
	ok: boolean;
	value?: T;
	errors: string[];
}

function ajvErrors(errors: ErrorObject[] | null | undefined): string[] {
	return (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
}

/** Full shape + semantic validation used by every graph ingress path. */
export function validateWorkflowGraph(
	value: unknown,
	opts: GraphValidationOptions = {},
): ValidationResult<WorkflowGraph> {
	if (!graphShapeValidator(value)) {
		return { ok: false, errors: ajvErrors(graphShapeValidator.errors) };
	}
	const graph = value as WorkflowGraph;
	const issues: string[] = [];
	const nodeIds = new Set<string>();
	for (const node of graph.nodes) {
		if (nodeIds.has(node.id)) issues.push(`duplicate node id ${node.id}`);
		nodeIds.add(node.id);
		if (opts.allowedAgentCards && !opts.allowedAgentCards.has(node.agentCard)) {
			issues.push(`node ${node.id} references unknown agent card ${node.agentCard}`);
		}
		if ((node.controlHandoff === true || node.agentCard === "master-handoff") && node.kind !== "planner") {
			issues.push(`control handoff node ${node.id} must have kind planner`);
		}
	}

	const edgeIds = new Set<string>();
	const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
	for (const edge of graph.edges) {
		if (edgeIds.has(edge.id)) issues.push(`duplicate edge id ${edge.id}`);
		edgeIds.add(edge.id);
		if (edge.from === "@output") issues.push(`edge ${edge.id} cannot originate at @output`);
		if (edge.to === "@input") issues.push(`edge ${edge.id} cannot target @input`);
		if (edge.from !== "@input" && !nodeIds.has(edge.from)) {
			issues.push(`edge ${edge.id} from unknown node ${edge.from}`);
		}
		if (edge.to !== "@output" && !nodeIds.has(edge.to)) {
			issues.push(`edge ${edge.id} to unknown node ${edge.to}`);
		}
		if (edge.kind === "FEEDBACK" && !edge.loopId) {
			issues.push(`feedback edge ${edge.id} must name a loop`);
		}
		if (edge.kind !== "FEEDBACK" && edge.loopId != null) {
			issues.push(`non-feedback edge ${edge.id} cannot name loop ${edge.loopId}`);
		}
	}

	const loopIds = new Set<string>();
	const feedbackMembership = new Map<string, string>();
	for (const loop of graph.loops) {
		if (loopIds.has(loop.id)) issues.push(`duplicate loop id ${loop.id}`);
		loopIds.add(loop.id);
		const body = new Set(loop.bodyNodes);
		for (const nodeId of loop.bodyNodes) {
			if (!nodeIds.has(nodeId)) issues.push(`loop ${loop.id} references unknown node ${nodeId}`);
		}
		for (const edgeId of loop.feedbackEdges) {
			const prior = feedbackMembership.get(edgeId);
			if (prior) issues.push(`feedback edge ${edgeId} belongs to both loop ${prior} and ${loop.id}`);
			feedbackMembership.set(edgeId, loop.id);
			const edge = edgeById.get(edgeId);
			if (!edge) {
				issues.push(`loop ${loop.id} references unknown edge ${edgeId}`);
				continue;
			}
			if (edge.kind !== "FEEDBACK") issues.push(`loop ${loop.id} edge ${edgeId} is not FEEDBACK`);
			if (edge.loopId !== loop.id) {
				issues.push(`feedback edge ${edgeId} names loop ${edge.loopId ?? "(none)"}, expected ${loop.id}`);
			}
			if (!body.has(edge.from) || !body.has(edge.to)) {
				issues.push(`feedback edge ${edgeId} endpoints must both be inside loop ${loop.id}`);
			}
		}
	}
	for (const edge of graph.edges.filter((e) => e.kind === "FEEDBACK")) {
		if (!edge.loopId || !loopIds.has(edge.loopId)) {
			issues.push(`feedback edge ${edge.id} references missing loop ${edge.loopId ?? "(none)"}`);
		}
		if (!feedbackMembership.has(edge.id)) {
			issues.push(`feedback edge ${edge.id} is not listed by its loop`);
		}
	}

	const executableEdges = graph.edges.filter((e) => e.kind !== "FEEDBACK");
	const forward = new Map<string, string[]>();
	const reverse = new Map<string, string[]>();
	for (const edge of executableEdges) {
		const out = forward.get(edge.from) ?? [];
		out.push(edge.to);
		forward.set(edge.from, out);
		const back = reverse.get(edge.to) ?? [];
		back.push(edge.from);
		reverse.set(edge.to, back);
	}

	const reachableFromInput = walk("@input", forward);
	if (!reachableFromInput.has("@output")) issues.push("@output is not reachable from @input");
	const canReachOutput = walk("@output", reverse);
	for (const node of graph.nodes) {
		const parents = executableEdges.filter((e) => e.to === node.id);
		if (parents.length === 0) issues.push(`node ${node.id} has no non-FEEDBACK incoming edge`);
		if (!reachableFromInput.has(node.id)) issues.push(`node ${node.id} is unreachable from @input`);
		if (!canReachOutput.has(node.id)) issues.push(`node ${node.id} cannot reach @output`);
	}

	if (hasCycle(graph)) issues.push("graph contains a cycle outside FEEDBACK edges");
	return issues.length ? { ok: false, errors: [...new Set(issues)] } : { ok: true, value: graph, errors: [] };
}

function walk(start: string, adj: Map<string, string[]>): Set<string> {
	const seen = new Set<string>();
	const stack = [start];
	while (stack.length) {
		const cur = stack.pop()!;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const next of adj.get(cur) ?? []) stack.push(next);
	}
	return seen;
}

function hasCycle(graph: WorkflowGraph): boolean {
	const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
	const adj = new Map(graph.nodes.map((n) => [n.id, [] as string[]]));
	for (const edge of graph.edges) {
		if (edge.kind === "FEEDBACK" || edge.from === "@input" || edge.to === "@output") continue;
		if (!adj.has(edge.from) || !indegree.has(edge.to)) continue;
		adj.get(edge.from)!.push(edge.to);
		indegree.set(edge.to, indegree.get(edge.to)! + 1);
	}
	const ready = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
	let visited = 0;
	while (ready.length) {
		const current = ready.pop()!;
		visited += 1;
		for (const next of adj.get(current) ?? []) {
			const d = indegree.get(next)! - 1;
			indegree.set(next, d);
			if (d === 0) ready.push(next);
		}
	}
	return visited !== graph.nodes.length;
}

const stringArray = { type: "array", items: { type: "string" } } as const;
const baseOutput = {
	type: "object",
	additionalProperties: true,
	required: ["summary"],
	properties: {
		summary: { type: "string", minLength: 1 },
		escalate: { type: ["boolean", "string"] },
		escalate_reason: { type: "string" },
	},
} as const;

const outputSchemas: Record<string, object> = {
	inspector: {
		...baseOutput,
		required: ["summary", "files_seen", "change_surface", "subtasks", "risks"],
		properties: {
			...baseOutput.properties,
			files_seen: stringArray,
			change_surface: stringArray,
			subtasks: stringArray,
			risks: stringArray,
		},
	},
	explorer: {
		oneOf: [
			{
				...baseOutput,
				required: ["summary", "approach", "key_files", "risks", "confidence"],
				properties: {
					...baseOutput.properties,
					approach: { type: "string", minLength: 1 },
					key_files: stringArray,
					risks: stringArray,
					confidence: { type: "number", minimum: 0, maximum: 1 },
				},
			},
			{
				...baseOutput,
				required: ["summary", "angle", "findings", "files_seen", "change_surface", "subtasks", "risks"],
				properties: {
					...baseOutput.properties,
					angle: { enum: ["correctness", "maintainability", "security", "quality"] },
					findings: { type: "array", items: { type: "object" } },
					files_seen: stringArray,
					change_surface: stringArray,
					subtasks: stringArray,
					risks: stringArray,
				},
			},
		],
	},
	aggregator: {
		...baseOutput,
		required: ["summary", "plan", "change_surface", "rejected", "risks"],
		properties: {
			...baseOutput.properties,
			plan: stringArray,
			change_surface: stringArray,
			rejected: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: true,
					required: ["from", "reason"],
					properties: { from: { type: "string" }, reason: { type: "string" } },
				},
			},
			risks: stringArray,
		},
	},
	implementer: {
		...baseOutput,
		required: ["summary", "files_changed", "approach", "commands_run", "concerns"],
		properties: {
			...baseOutput.properties,
			files_changed: stringArray,
			approach: { type: "string" },
			commands_run: stringArray,
			concerns: stringArray,
		},
	},
	verifier: {
		...baseOutput,
		required: ["summary", "verdict", "checks", "must_fix"],
		properties: {
			...baseOutput.properties,
			verdict: { enum: ["pass", "fail", "escalate"] },
			checks: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: true,
					required: ["name", "result", "evidence"],
					properties: {
						name: { type: "string", minLength: 1 },
						result: { enum: ["pass", "fail", "skipped"] },
						evidence: { type: "string" },
					},
				},
			},
			must_fix: stringArray,
		},
	},
	"master-handoff": baseOutput,
	"meta-improver": baseOutput,
};

const outputValidators = new Map<string, ValidateFunction>(
	Object.entries(outputSchemas).map(([name, schema]) => [name, ajv.compile(schema)]),
);
const fallbackOutputValidator = ajv.compile(baseOutput);

export function validateAgentOutput(agentCard: string, value: unknown): ValidationResult<NodeOutput> {
	const validator = outputValidators.get(agentCard) ?? fallbackOutputValidator;
	if (!validator(value)) return { ok: false, errors: ajvErrors(validator.errors) };
	return { ok: true, value: value as NodeOutput, errors: [] };
}
