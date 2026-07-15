/** Pure immutable mutations for the WorkflowGraph editor. Browser- and test-safe. */

export const emptyGraph = () => ({ nodes: [], edges: [], loops: [] });

export function cloneGraph(graph) {
	return {
		nodes: (graph?.nodes ?? []).map((node) => ({
			...node,
			budget: node.budget ? { ...node.budget } : undefined,
		})),
		edges: (graph?.edges ?? []).map((edge) => ({ ...edge })),
		loops: (graph?.loops ?? []).map((loop) => ({
			...loop,
			bodyNodes: [...loop.bodyNodes],
			feedbackEdges: [...loop.feedbackEdges],
		})),
	};
}

export function nextId(prefix, existing) {
	const used = existing instanceof Set ? existing : new Set(existing);
	if (!used.has(prefix)) return prefix;
	for (let i = 2; i < 10000; i += 1) {
		const candidate = `${prefix}_${i}`;
		if (!used.has(candidate)) return candidate;
	}
	throw new Error(`could not allocate id for ${prefix}`);
}

export function addNode(graph, partial = {}) {
	const next = cloneGraph(graph);
	const id = partial.id || nextId("node", next.nodes.map((node) => node.id));
	if (next.nodes.some((node) => node.id === id)) throw new Error(`node ${id} already exists`);
	next.nodes.push({
		id,
		kind: partial.kind ?? "worker",
		agentCard: partial.agentCard ?? "implementer",
		trigger: partial.trigger ?? "ALL_SUCCESS",
		promptTemplate: partial.promptTemplate ?? "Task:\n${task}\n\nUpstream:\n${upstream}",
		...(partial.controlHandoff ? { controlHandoff: true } : {}),
		...(partial.budget ? { budget: { ...partial.budget } } : {}),
	});
	return { graph: next, id };
}

export function updateNode(graph, nodeId, patch) {
	const next = cloneGraph(graph);
	const node = next.nodes.find((item) => item.id === nodeId);
	if (!node) throw new Error(`unknown node ${nodeId}`);
	const newId = patch.id ?? nodeId;
	if (newId !== nodeId && next.nodes.some((item) => item.id === newId)) {
		throw new Error(`node ${newId} already exists`);
	}
	Object.assign(node, patch, { id: newId });
	if (patch.budget === null) delete node.budget;
	else if (patch.budget) node.budget = { ...patch.budget };
	if (patch.controlHandoff === false) delete node.controlHandoff;
	if (newId !== nodeId) {
		for (const edge of next.edges) {
			if (edge.from === nodeId) edge.from = newId;
			if (edge.to === nodeId) edge.to = newId;
		}
		for (const loop of next.loops) {
			loop.bodyNodes = loop.bodyNodes.map((id) => id === nodeId ? newId : id);
		}
	}
	return next;
}

export function removeNode(graph, nodeId) {
	const next = cloneGraph(graph);
	const removedEdges = new Set(next.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId).map((edge) => edge.id));
	next.nodes = next.nodes.filter((node) => node.id !== nodeId);
	next.edges = next.edges.filter((edge) => !removedEdges.has(edge.id));
	next.loops = next.loops
		.map((loop) => ({
			...loop,
			bodyNodes: loop.bodyNodes.filter((id) => id !== nodeId),
			feedbackEdges: loop.feedbackEdges.filter((id) => !removedEdges.has(id)),
		}))
		.filter((loop) => loop.bodyNodes.length > 0 && loop.feedbackEdges.length > 0);
	const liveLoops = new Set(next.loops.map((loop) => loop.id));
	next.edges = next.edges.filter((edge) => edge.kind !== "FEEDBACK" || (edge.loopId && liveLoops.has(edge.loopId)));
	return next;
}

export function addEdge(graph, partial) {
	const next = cloneGraph(graph);
	const id = partial.id || nextId("edge", next.edges.map((edge) => edge.id));
	if (next.edges.some((edge) => edge.id === id)) throw new Error(`edge ${id} already exists`);
	const edge = {
		id,
		from: partial.from,
		to: partial.to,
		kind: partial.kind ?? "DATA",
	};
	if (edge.kind === "FEEDBACK") edge.loopId = partial.loopId ?? null;
	next.edges.push(edge);
	return { graph: next, id };
}

export function updateEdge(graph, edgeId, patch) {
	const next = cloneGraph(graph);
	const edge = next.edges.find((item) => item.id === edgeId);
	if (!edge) throw new Error(`unknown edge ${edgeId}`);
	const oldId = edge.id;
	const newId = patch.id ?? edgeId;
	if (newId !== edgeId && next.edges.some((item) => item.id === newId)) {
		throw new Error(`edge ${newId} already exists`);
	}
	Object.assign(edge, patch, { id: newId });
	if (edge.kind !== "FEEDBACK") delete edge.loopId;
	else if (!("loopId" in edge)) edge.loopId = null;
	for (const loop of next.loops) {
		loop.feedbackEdges = loop.feedbackEdges
			.map((id) => id === oldId ? newId : id)
			.filter((id) => edge.kind === "FEEDBACK" || id !== newId);
		if (edge.kind === "FEEDBACK" && edge.loopId === loop.id && !loop.feedbackEdges.includes(newId)) {
			loop.feedbackEdges.push(newId);
		}
		if (edge.kind === "FEEDBACK" && edge.loopId !== loop.id) {
			loop.feedbackEdges = loop.feedbackEdges.filter((id) => id !== newId);
		}
	}
	next.loops = next.loops.filter((loop) => loop.feedbackEdges.length > 0 && loop.bodyNodes.length > 0);
	return next;
}

export function bindFeedbackEdge(graph, edgeId, loopId) {
	return updateEdge(graph, edgeId, { kind: "FEEDBACK", loopId });
}

export function removeEdge(graph, edgeId) {
	const next = cloneGraph(graph);
	next.edges = next.edges.filter((edge) => edge.id !== edgeId);
	next.loops = next.loops
		.map((loop) => ({ ...loop, feedbackEdges: loop.feedbackEdges.filter((id) => id !== edgeId) }))
		.filter((loop) => loop.feedbackEdges.length > 0 && loop.bodyNodes.length > 0);
	return next;
}

export function addLoop(graph, partial = {}) {
	const next = cloneGraph(graph);
	const id = partial.id || nextId("loop", next.loops.map((loop) => loop.id));
	if (next.loops.some((loop) => loop.id === id)) throw new Error(`loop ${id} already exists`);
	const loop = {
		id,
		bodyNodes: [...(partial.bodyNodes ?? next.nodes.slice(0, 1).map((node) => node.id))],
		feedbackEdges: [...(partial.feedbackEdges ?? [])],
		maxIterations: partial.maxIterations ?? 2,
	};
	next.loops.push(loop);
	for (const edgeId of loop.feedbackEdges) {
		const edge = next.edges.find((item) => item.id === edgeId);
		if (edge) {
			edge.kind = "FEEDBACK";
			edge.loopId = id;
		}
	}
	return { graph: next, id };
}

export function updateLoop(graph, loopId, patch) {
	const next = cloneGraph(graph);
	const loop = next.loops.find((item) => item.id === loopId);
	if (!loop) throw new Error(`unknown loop ${loopId}`);
	const newId = patch.id ?? loopId;
	if (newId !== loopId && next.loops.some((item) => item.id === newId)) {
		throw new Error(`loop ${newId} already exists`);
	}
	const previousEdges = new Set(loop.feedbackEdges);
	Object.assign(loop, patch, { id: newId });
	if (patch.bodyNodes) loop.bodyNodes = [...patch.bodyNodes];
	if (patch.feedbackEdges) loop.feedbackEdges = [...patch.feedbackEdges];
	const selected = new Set(loop.feedbackEdges);
	for (const other of next.loops) {
		if (other === loop) continue;
		other.feedbackEdges = other.feedbackEdges.filter((id) => !selected.has(id));
	}
	for (const edge of next.edges) {
		if (selected.has(edge.id)) {
			edge.kind = "FEEDBACK";
			edge.loopId = newId;
		} else if (previousEdges.has(edge.id) && (edge.loopId === loopId || edge.loopId === newId)) {
			edge.kind = "DATA";
			delete edge.loopId;
		} else if (newId !== loopId && edge.loopId === loopId) {
			edge.loopId = newId;
		}
	}
	next.loops = next.loops.filter((item) => item === loop || item.feedbackEdges.length > 0);
	return next;
}

export function removeLoop(graph, loopId) {
	const next = cloneGraph(graph);
	const loop = next.loops.find((item) => item.id === loopId);
	const feedback = new Set(loop?.feedbackEdges ?? []);
	next.loops = next.loops.filter((item) => item.id !== loopId);
	next.edges = next.edges.filter((edge) => !(edge.kind === "FEEDBACK" && (edge.loopId === loopId || feedback.has(edge.id))));
	return next;
}
