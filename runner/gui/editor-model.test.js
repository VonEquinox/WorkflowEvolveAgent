import test from "node:test";
import assert from "node:assert/strict";
import {
	addEdge,
	addLoop,
	addNode,
	bindFeedbackEdge,
	emptyGraph,
	removeEdge,
	removeNode,
	updateEdge,
	updateLoop,
	updateNode,
} from "./editor-model.js";

function baseGraph() {
	let graph = emptyGraph();
	({ graph } = addNode(graph, { id: "implement" }));
	({ graph } = addNode(graph, { id: "verify", kind: "verifier", agentCard: "verifier" }));
	({ graph } = addEdge(graph, { id: "in", from: "@input", to: "implement" }));
	({ graph } = addEdge(graph, { id: "iv", from: "implement", to: "verify" }));
	({ graph } = addEdge(graph, { id: "out", from: "verify", to: "@output" }));
	return graph;
}

test("renaming a node updates edges and loop body references", () => {
	let graph = baseGraph();
	({ graph } = addEdge(graph, { id: "feedback", from: "verify", to: "implement", kind: "FEEDBACK", loopId: "fix" }));
	({ graph } = addLoop(graph, { id: "fix", bodyNodes: ["implement", "verify"], feedbackEdges: ["feedback"] }));
	graph = updateNode(graph, "implement", { id: "apply" });
	assert.equal(graph.edges.find((edge) => edge.id === "in").to, "apply");
	assert.deepEqual(graph.loops[0].bodyNodes, ["apply", "verify"]);
});

test("removing a node cleans incident edges and invalidated loops", () => {
	let graph = baseGraph();
	({ graph } = addEdge(graph, { id: "feedback", from: "verify", to: "implement", kind: "FEEDBACK", loopId: "fix" }));
	({ graph } = addLoop(graph, { id: "fix", bodyNodes: ["implement", "verify"], feedbackEdges: ["feedback"] }));
	graph = removeNode(graph, "verify");
	assert.deepEqual(graph.nodes.map((node) => node.id), ["implement"]);
	assert.equal(graph.edges.some((edge) => edge.from === "verify" || edge.to === "verify"), false);
	assert.equal(graph.loops.length, 0);
});

test("changing an edge out of feedback removes empty loop metadata", () => {
	let graph = baseGraph();
	({ graph } = addEdge(graph, { id: "feedback", from: "verify", to: "implement", kind: "FEEDBACK", loopId: "fix" }));
	({ graph } = addLoop(graph, { id: "fix", bodyNodes: ["implement", "verify"], feedbackEdges: ["feedback"] }));
	graph = updateEdge(graph, "feedback", { kind: "DATA" });
	assert.equal(graph.loops.length, 0);
	assert.equal("loopId" in graph.edges.find((edge) => edge.id === "feedback"), false);
});

test("binding feedback moves the edge between loops", () => {
	let graph = baseGraph();
	({ graph } = addEdge(graph, { id: "feedback", from: "verify", to: "implement" }));
	({ graph } = addLoop(graph, { id: "fix", bodyNodes: ["implement", "verify"], feedbackEdges: [] }));
	// Empty loops are allowed in editor state and rejected by runtime validation until bound.
	graph = bindFeedbackEdge(graph, "feedback", "fix");
	assert.equal(graph.edges.find((edge) => edge.id === "feedback").loopId, "fix");
	assert.deepEqual(graph.loops.find((loop) => loop.id === "fix").feedbackEdges, ["feedback"]);
});

test("edge and loop renames update both sides of feedback binding", () => {
	let graph = baseGraph();
	({ graph } = addEdge(graph, { id: "feedback", from: "verify", to: "implement", kind: "FEEDBACK", loopId: "fix" }));
	({ graph } = addLoop(graph, { id: "fix", bodyNodes: ["implement", "verify"], feedbackEdges: ["feedback"] }));
	graph = updateEdge(graph, "feedback", { id: "retry" });
	assert.deepEqual(graph.loops[0].feedbackEdges, ["retry"]);
	graph = updateLoop(graph, "fix", { id: "repair" });
	assert.equal(graph.edges.find((edge) => edge.id === "retry").loopId, "repair");
	graph = removeEdge(graph, "retry");
	assert.equal(graph.loops.length, 0);
});
