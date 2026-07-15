/* WEA GUI — run monitor + immutable visual WorkflowGraph editor. */

import {
	addEdge,
	addLoop,
	addNode,
	bindFeedbackEdge,
	cloneGraph,
	emptyGraph,
	removeEdge,
	removeLoop,
	removeNode,
	updateEdge,
	updateLoop,
	updateNode,
} from "./editor-model.js";

const $ = (id) => document.getElementById(id);
const NODE_W = 176, NODE_H = 68, GAP_X = 72, GAP_Y = 30, PAD = 64;

const STATE_MAP = {
	DECLARED: "waiting", WAITING_DEPS: "waiting", READY: "ready",
	RUNNING: "running", SUCCEEDED: "succeeded", FAILED: "failed",
	CANCELLED: "failed", SKIPPED: "waiting",
};
const STATE_ICON = { waiting: "○", ready: "◔", running: "◐", succeeded: "✓", failed: "✕", editing: "✎" };

const S = {
	view: "run",
	templates: new Map(),
	installedCards: new Map(),
	graph: null,
	runtimeCards: {},
	nodes: new Map(),
	els: new Map(),
	edgeEls: [],
	runStatus: "idle",
	startedAt: null,
	timer: null,
	totals: { tokens: 0, cost: 0 },
	es: null,
	detailNode: null,
	editor: null,
	validationSeq: 0,
	validationTimer: null,
	drag: null,
	justDragged: false,
	renderLayout: null,
};

const fmtTok = (n) => (n >= 1000 ? n.toLocaleString("en-US") : String(n));
const fmtCost = (micro) => "$" + (micro / 1e6).toFixed(4);
const now = () => new Date().toTimeString().slice(0, 8);
const fmtElapsed = (ms) => {
	const seconds = Math.floor(ms / 1000);
	return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({
	"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);
const escapeAttr = escapeHtml;

async function api(path, options = {}) {
	const response = await fetch(path, options);
	let body = {};
	try { body = await response.json(); } catch { /* empty body */ }
	if (!response.ok) {
		const error = new Error(body.error || `HTTP ${response.status}`);
		error.status = response.status;
		error.details = body.errors ?? [];
		throw error;
	}
	return body;
}

// ---- boot / template catalog -------------------------------------------------

async function boot() {
	await fetch("/api/health").catch(() => null);
	const [, cards] = await Promise.all([refreshTemplates(), api("/api/agent-cards")]);
	S.installedCards = new Map(cards.cards.map((card) => [card.name, card]));

	$("template").addEventListener("change", () => {
		updateTemplateHint();
		if (S.view === "run") previewTemplate($("template").value);
	});
	$("runViewBtn").addEventListener("click", () => switchView("run"));
	$("editViewBtn").addEventListener("click", () => switchView("edit"));
	$("runForm").addEventListener("submit", startRun);
	$("newGraphBtn").addEventListener("click", beginNewGraph);
	$("editTemplateBtn").addEventListener("click", editSelectedTemplate);
	$("addNodeBtn").addEventListener("click", editorAddNode);
	$("connectBtn").addEventListener("click", toggleConnectMode);
	$("addLoopBtn").addEventListener("click", editorAddLoop);
	$("deleteSelectedBtn").addEventListener("click", deleteEditorSelection);
	$("validateGraphBtn").addEventListener("click", () => validateEditorNow());
	$("saveGraphBtn").addEventListener("click", saveEditorGraph);
	$("editorTemplateId").addEventListener("input", editorMetadataChanged);
	$("editorSummary").addEventListener("input", editorMetadataChanged);
	$("detailClose").addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		closeDetail();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			if (S.editor?.connectingFrom) {
				S.editor.connectingFrom = null;
				S.editor.connectMode = false;
				renderDag();
				updateEditorNotice();
			} else closeDetail();
		}
		if ((event.key === "Delete" || event.key === "Backspace") && S.view === "edit" && !event.target.matches("input,textarea,select")) {
			deleteEditorSelection();
		}
	});
	$("canvas").addEventListener("click", (event) => {
		if (event.target.closest?.("g.node") || event.target.closest?.("path.edge") || event.target.closest?.(".graph-port")) return;
		if (S.view === "edit" && S.editor) selectEditorElement(null);
		else closeDetail();
	});
	window.addEventListener("pointermove", moveNodeDrag);
	window.addEventListener("pointerup", endNodeDrag);

	previewTemplate("auto");
}

async function refreshTemplates(selectRef) {
	const data = await api("/api/templates");
	S.templates = new Map(data.templates.map((template) => [template.ref, template]));
	const select = $("template");
	const desired = selectRef ?? select.value ?? "auto";
	select.innerHTML = '<option value="auto">auto — control/retrieval picks</option>';
	for (const template of data.templates) {
		const option = document.createElement("option");
		option.value = template.ref;
		option.disabled = template.validationErrors.length > 0;
		const flags = [template.isLatest ? "latest" : "", template.catalog === false ? "stage" : "", option.disabled ? "invalid" : ""]
			.filter(Boolean).join(", ");
		option.textContent = `${template.ref} — ${template.summary.slice(0, 62)}${flags ? ` [${flags}]` : ""}`;
		select.appendChild(option);
	}
	select.value = S.templates.has(desired) ? desired : "auto";
	updateTemplateHint();
	return data;
}

function updateTemplateHint() {
	const ref = $("template").value;
	const template = S.templates.get(ref);
	if (!template) {
		$("templateHint").textContent = "auto planning uses control when configured, otherwise worker-only retrieval";
		return;
	}
	$("templateHint").textContent = `${template.id}@${template.version}${template.isLatest ? " · latest" : " · historical"}${template.catalog === false ? " · internal stage" : ""}`;
}

function previewTemplate(ref) {
	if (S.runStatus === "running" || S.view !== "run") return;
	if (ref === "auto") {
		$("graphTitle").textContent = "auto — workflow is selected at run time";
		$("graphMeta").textContent = "";
		S.graph = null;
		clearDag();
		return;
	}
	const template = S.templates.get(ref);
	if (!template) return;
	initRuntimeGraph(template.graph, {});
	$("graphTitle").textContent = `${template.ref}`;
	$("graphMeta").textContent = `${template.graph.nodes.length} nodes · preview`;
	renderDag();
}

function switchView(view) {
	if (view === "edit" && S.runStatus === "running") {
		feed("", "graph editing is locked while a run is active", "warn");
		return;
	}
	S.view = view;
	$("app").dataset.view = view;
	$("runViewBtn").classList.toggle("selected", view === "run");
	$("editViewBtn").classList.toggle("selected", view === "edit");
	$("runForm").hidden = view !== "run";
	$("editorPanel").hidden = view !== "edit";
	$("runLegend").hidden = view !== "run";
	$("editorLegend").hidden = view !== "edit";
	$("feedWrap").hidden = view !== "run";
	if (view === "run") {
		closeDetail();
		previewTemplate($("template").value);
	} else if (S.editor) {
		renderEditorWorkspace();
	} else {
		S.graph = null;
		clearDag();
		$("graphTitle").textContent = "Create a graph or edit the selected template";
		$("graphMeta").textContent = "";
	}
}

// ---- run lifecycle -----------------------------------------------------------

async function startRun(event) {
	event.preventDefault();
	if (S.runStatus === "running") return;
	const body = {
		task: $("task").value.trim(),
		template: $("template").value,
		repo: $("repo").value.trim() || undefined,
	};
	if (!body.task) return;

	$("runBtn").disabled = true;
	$("editViewBtn").disabled = true;
	setChip("running", "starting…");
	feed("", "POST /api/run …");
	let response;
	try {
		response = await api("/api/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		setChip("failure", "failed to start");
		feed("", `error: ${error.message}`, "err");
		$("runBtn").disabled = false;
		$("editViewBtn").disabled = false;
		return;
	}

	S.es = new EventSource(`/api/run/${response.runId}/events`);
	S.es.onmessage = (message) => handleRunEvent(JSON.parse(message.data));
	S.es.onerror = () => { if (S.runStatus !== "running") S.es?.close(); };
}

function handleRunEvent(event) {
	switch (event.type) {
		case "template_resolved":
			feed("", event.why);
			break;
		case "run_started":
			S.runStatus = "running";
			S.totals = { tokens: 0, cost: 0 };
			S.startedAt = Date.now();
			S.runtimeCards = event.cards;
			initRuntimeGraph(event.graph, event.cards);
			renderDag();
			$("graphTitle").textContent = `${event.templateRef} @ ${event.templateVersion}`;
			$("graphMeta").textContent = `${event.graph.nodes.length} nodes · generation ${event.graphGeneration} · run ${event.runId.slice(0, 8)}`;
			setChip("running", "running");
			clearInterval(S.timer);
			S.timer = setInterval(() => { $("statElapsed").textContent = fmtElapsed(Date.now() - S.startedAt); }, 500);
			updateStats();
			feed("", `run started: ${event.templateRef}`);
			break;
		case "node_state": {
			const node = S.nodes.get(event.nodeId);
			if (!node) break;
			node.state = STATE_MAP[event.state] ?? "waiting";
			node.attemptNo = event.attemptNo;
			if (node.state === "failed" && event.detail) {
				node.error = event.detail;
				feed(event.nodeId, event.detail, "err");
			}
			updateNodeEl(event.nodeId);
			refreshRuntimeEdges();
			updateStats();
			if (S.detailNode === event.nodeId) openRuntimeDetail(event.nodeId);
			break;
		}
		case "node_activity": {
			const node = S.nodes.get(event.nodeId);
			if (!node) break;
			const activity = event.activity;
			let line = "";
			if (activity.kind === "tool_call") {
				node.tools += 1;
				line = `▸ ${activity.tool} ${activity.detail}`;
			} else if (activity.kind === "tool_result") {
				line = `${activity.isError ? "✕" : "·"} ${activity.tool} → ${activity.chars.toLocaleString()} chars`;
			} else if (activity.kind === "llm") {
				node.tokens += activity.inputTokens + activity.outputTokens;
				node.cost += activity.costMicrounits;
				line = `Σ +${fmtTok(activity.inputTokens + activity.outputTokens)} tok · ${fmtCost(activity.costMicrounits)}`;
			}
			node.acts.push(line);
			if (node.acts.length > 60) node.acts.shift();
			feed(event.nodeId, line, activity.kind === "tool_result" && activity.isError ? "err" : "");
			updateNodeEl(event.nodeId);
			if (S.detailNode === event.nodeId) openRuntimeDetail(event.nodeId);
			break;
		}
		case "escalation":
			feed(event.nodeId, `⚠ escalate: ${event.reason}`, "warn");
			break;
		case "master_replan":
			feed("master", `replan ${event.ok ? "ok" : "fail"}: ${event.why}`, event.ok ? "ok" : "err");
			if (event.ok && event.graph) {
				initRuntimeGraph(event.graph, {});
				renderDag();
				$("graphTitle").textContent = `${event.templateRef || "replan"} · master replan`;
			}
			break;
		case "master_handoff":
			feed(event.nodeId, `◆ WEA handoff ${event.ok ? "ok" : "fail"}: ${event.why}`, event.ok ? "ok" : "err");
			if (event.ok && event.editGraph) {
				initRuntimeGraph(event.editGraph, {});
				renderDag();
				$("graphTitle").textContent = `${event.templateRef || "edit"} · after master handoff`;
			}
			break;
		case "master_improve":
			feed("master", `improve ${event.ok ? "ok" : "fail"} applied=${event.applied}: ${event.why}`, event.ok ? "ok" : "warn");
			break;
		case "node_result": {
			const node = S.nodes.get(event.nodeId);
			if (!node) break;
			node.summary = event.summary;
			node.output = event.output;
			node.error = event.error;
			node.tokens = event.tokens;
			node.cost = event.costMicrounits;
			node.tools = event.toolCalls;
			feed(event.nodeId, event.status === "success" ? `✓ ${event.summary}` : `✕ ${event.error}`, event.status === "success" ? "ok" : "err");
			if (S.detailNode === event.nodeId) openRuntimeDetail(event.nodeId);
			break;
		}
		case "loop":
			feed("", event.exhausted ? `loop ${event.loopId} exhausted (iteration ${event.iteration})` : `loop ${event.loopId} → iteration ${event.iteration}`, "warn");
			break;
		case "budget":
			S.totals.tokens = event.tokensUsed;
			S.totals.cost = event.costMicrounits;
			updateStats();
			break;
		case "log":
			feed("", event.message);
			break;
		case "run_done":
			S.runStatus = event.status;
			clearInterval(S.timer);
			setChip(event.status, event.status === "success" ? "success" : "failed");
			S.totals.tokens = event.tokens;
			S.totals.cost = event.costMicrounits;
			updateStats();
			feed("", `run done: ${event.status} · ${fmtTok(event.tokens)} tok · ${fmtCost(event.costMicrounits)}`, event.status === "success" ? "ok" : "err");
			for (const file of event.files) feed("", `wrote ${file.split("/").pop()}`);
			$("runBtn").disabled = false;
			$("editViewBtn").disabled = false;
			S.es?.close();
			break;
	}
}

function initRuntimeGraph(graph) {
	S.graph = cloneGraph(graph);
	S.nodes.clear();
	for (const node of graph.nodes) {
		S.nodes.set(node.id, {
			state: "waiting", attemptNo: 1, tokens: 0, cost: 0, tools: 0,
			acts: [], output: null, error: null, summary: "", kind: node.kind, card: node.agentCard,
		});
	}
}

// ---- editor lifecycle ---------------------------------------------------------

function editorMetadataChanged() {
	if (!S.editor) return;
	S.editor.id = $("editorTemplateId").value.trim();
	S.editor.summary = $("editorSummary").value;
	S.editor.dirty = true;
	scheduleEditorValidation();
}

function beginNewGraph() {
	S.editor = {
		operation: "create",
		sourceRef: null,
		sourceVersion: null,
		id: "custom-workflow",
		summary: "Custom workflow created in the WEA graph editor.",
		graph: emptyGraph(),
		ui: { positions: {} },
		selected: null,
		connectMode: false,
		connectingFrom: null,
		validation: { ok: false, errors: ["add at least one node"] },
		dirty: true,
	};
	loadEditorFields();
	renderEditorWorkspace();
	validateEditorNow();
}

function editSelectedTemplate() {
	const selected = S.templates.get($("template").value);
	if (!selected) {
		showEditorNotice("Select a concrete template first", "warn");
		return;
	}
	const latest = selected.isLatest
		? selected
		: [...S.templates.values()].find((item) => item.id === selected.id && item.isLatest) ?? selected;
	const historicalNotice = latest.ref !== selected.ref
		? `Loaded latest revision ${latest.ref} instead of historical ${selected.ref}`
		: null;
	if (historicalNotice) {
		$("template").value = latest.ref;
		updateTemplateHint();
	}
	const liveNodeIds = new Set(latest.graph.nodes.map((node) => node.id));
	const positions = Object.fromEntries(
		Object.entries(structuredClone(latest.ui?.positions ?? {})).filter(([nodeId]) => liveNodeIds.has(nodeId)),
	);
	S.editor = {
		operation: "revise",
		sourceRef: latest.ref,
		sourceVersion: latest.version,
		id: latest.id,
		summary: latest.summary,
		graph: cloneGraph(latest.graph),
		ui: { positions },
		selected: null,
		connectMode: false,
		connectingFrom: null,
		validation: { ok: false, errors: [] },
		dirty: false,
	};
	loadEditorFields();
	renderEditorWorkspace();
	if (historicalNotice) showEditorNotice(historicalNotice, "warn");
	validateEditorNow();
}

function loadEditorFields() {
	$("editorFields").hidden = false;
	$("editorSource").textContent = S.editor.operation === "create"
		? "new base template · server assigns version 1.0.0"
		: `revision of ${S.editor.sourceRef} · source version ${S.editor.sourceVersion}`;
	$("editorTemplateId").value = S.editor.id;
	$("editorTemplateId").disabled = S.editor.operation === "revise";
	$("editorSummary").value = S.editor.summary;
	updateDeleteButton();
	renderLoopList();
}

function renderEditorWorkspace() {
	if (!S.editor) return;
	S.graph = S.editor.graph;
	$("graphTitle").textContent = S.editor.operation === "create" ? S.editor.id : `${S.editor.id} · editing ${S.editor.sourceRef}`;
	$("graphMeta").textContent = `${S.editor.graph.nodes.length} nodes · ${S.editor.graph.edges.length} edges · ${S.editor.graph.loops.length} loops`;
	renderDag();
	renderLoopList();
	updateEditorNotice();
	if (S.editor.selected) openEditorInspector();
	else {
		$("detail").hidden = true;
		$("detail").style.display = "none";
	}
}

function editorAddNode() {
	if (!S.editor) return;
	const defaultCard = S.installedCards.has("implementer") ? "implementer" : S.installedCards.keys().next().value ?? "implementer";
	const result = addNode(S.editor.graph, { agentCard: defaultCard });
	S.editor.graph = result.graph;
	const count = S.editor.graph.nodes.length - 1;
	S.editor.ui.positions[result.id] = { x: 140 + (count % 3) * 240, y: 70 + Math.floor(count / 3) * 120 };
	S.editor.selected = { type: "node", id: result.id };
	editorChanged();
}

function toggleConnectMode() {
	if (!S.editor) return;
	S.editor.connectMode = !S.editor.connectMode;
	S.editor.connectingFrom = null;
	$("connectBtn").classList.toggle("active", S.editor.connectMode);
	updateEditorNotice();
	renderDag();
}

function editorAddLoop() {
	if (!S.editor) return;
	if (S.editor.selected?.type !== "edge") {
		showEditorNotice("Select an edge, then press Loop to convert it into FEEDBACK", "warn");
		return;
	}
	const edge = S.editor.graph.edges.find((item) => item.id === S.editor.selected.id);
	if (!edge || edge.from === "@input" || edge.to === "@output") {
		showEditorNotice("A loop feedback edge must connect two workflow nodes", "warn");
		return;
	}
	const result = addLoop(S.editor.graph, {
		bodyNodes: [...new Set([edge.to, edge.from])],
		feedbackEdges: [edge.id],
		maxIterations: 2,
	});
	S.editor.graph = bindFeedbackEdge(result.graph, edge.id, result.id);
	S.editor.selected = { type: "loop", id: result.id };
	editorChanged();
}

function deleteEditorSelection() {
	if (!S.editor?.selected) return;
	const { type, id } = S.editor.selected;
	if (type === "node") {
		S.editor.graph = removeNode(S.editor.graph, id);
		delete S.editor.ui.positions[id];
	} else if (type === "edge") S.editor.graph = removeEdge(S.editor.graph, id);
	else if (type === "loop") S.editor.graph = removeLoop(S.editor.graph, id);
	S.editor.selected = null;
	closeDetail();
	editorChanged();
}

function editorChanged({ render = true } = {}) {
	if (!S.editor) return;
	S.editor.dirty = true;
	S.graph = S.editor.graph;
	if (render) renderEditorWorkspace();
	updateDeleteButton();
	scheduleEditorValidation();
}

function scheduleEditorValidation() {
	clearTimeout(S.validationTimer);
	S.validationTimer = setTimeout(() => validateEditorNow(), 250);
	setValidationState("pending", ["validating…"]);
}

function localEditorErrors() {
	if (!S.editor) return ["no graph loaded"];
	const errors = [];
	if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(S.editor.id)) errors.push("template id must match ^[A-Za-z][A-Za-z0-9_.-]{0,63}$");
	if (!S.editor.summary.trim()) errors.push("summary is required");
	return errors;
}

async function validateEditorNow() {
	if (!S.editor) return false;
	clearTimeout(S.validationTimer);
	const sequence = ++S.validationSeq;
	setValidationState("pending", ["validating…"]);
	let result;
	try {
		result = await api("/api/graphs/validate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ graph: S.editor.graph, ui: S.editor.ui }),
		});
	} catch (error) {
		if (sequence !== S.validationSeq) return false;
		setValidationState("invalid", [error.message]);
		return false;
	}
	if (sequence !== S.validationSeq) return false;
	const errors = [...localEditorErrors(), ...(result.errors ?? [])];
	S.editor.validation = { ok: errors.length === 0, errors };
	setValidationState(errors.length === 0 ? "valid" : "invalid", errors);
	return errors.length === 0;
}

function setValidationState(state, errors) {
	$("validationBox").dataset.state = state;
	$("validationTitle").textContent = state === "valid" ? "✓ Graph is executable" : state === "invalid" ? `✕ ${errors.length} validation issue${errors.length === 1 ? "" : "s"}` : "Validating graph…";
	$("validationErrors").innerHTML = state === "valid" ? "" : errors.slice(0, 12).map((error) => `<li>${escapeHtml(error)}</li>`).join("");
	$("saveGraphBtn").disabled = state !== "valid";
}

async function saveEditorGraph() {
	if (!S.editor || !(await validateEditorNow())) return;
	const button = $("saveGraphBtn");
	button.disabled = true;
	button.textContent = "Saving…";
	const body = S.editor.operation === "create"
		? {
			operation: "create", id: S.editor.id, summary: S.editor.summary.trim(),
			graph: S.editor.graph, ui: S.editor.ui,
		}
		: {
			operation: "revise", sourceRef: S.editor.sourceRef, sourceVersion: S.editor.sourceVersion,
			summary: S.editor.summary.trim(), graph: S.editor.graph, ui: S.editor.ui,
		};
	try {
		const saved = await api("/api/templates", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		await refreshTemplates(saved.template.ref);
		editSelectedTemplate();
		showEditorNotice(`Saved ${saved.template.ref} without overwriting prior versions`, "ok");
	} catch (error) {
		setValidationState("invalid", [error.message, ...(error.details ?? [])]);
		showEditorNotice(`Save failed: ${error.message}`, "err");
	} finally {
		button.textContent = "Save immutable version";
		button.disabled = !S.editor?.validation?.ok;
	}
}

function selectEditorElement(selection) {
	if (!S.editor) return;
	S.editor.selected = selection;
	updateDeleteButton();
	renderDag();
	if (selection) openEditorInspector();
	else closeDetail();
}

function updateDeleteButton() {
	$("deleteSelectedBtn").disabled = !S.editor?.selected;
}

function renderLoopList() {
	const box = $("loopList");
	if (!S.editor || S.editor.graph.loops.length === 0) {
		box.innerHTML = '<span class="field-hint">none — select an edge and press Loop</span>';
		return;
	}
	box.innerHTML = S.editor.graph.loops.map((loop) => `
		<button type="button" class="loop-pill${S.editor.selected?.type === "loop" && S.editor.selected.id === loop.id ? " selected" : ""}" data-loop-id="${escapeAttr(loop.id)}">
			↺ ${escapeHtml(loop.id)} · max ${loop.maxIterations}
		</button>`).join("");
	for (const button of box.querySelectorAll("[data-loop-id]")) {
		button.addEventListener("click", () => selectEditorElement({ type: "loop", id: button.dataset.loopId }));
	}
}

function updateEditorNotice() {
	if (!S.editor) return;
	$("connectBtn").classList.toggle("active", S.editor.connectMode);
	if (S.editor.connectingFrom) showEditorNotice(`Connect source ${S.editor.connectingFrom}: choose a target input port`, "info");
	else if (S.editor.connectMode) showEditorNotice("Connect mode: choose a source output port", "info");
	else $("editorNotice").hidden = true;
}

function showEditorNotice(message, state = "info") {
	const notice = $("editorNotice");
	notice.hidden = false;
	notice.dataset.state = state;
	notice.textContent = message;
}

// ---- layout / SVG rendering ---------------------------------------------------

function autoLayout(graph) {
	if (!graph || graph.nodes.length === 0) return { pos: new Map(), width: 760, height: 360 };
	const depth = new Map();
	const parents = new Map(graph.nodes.map((node) => [node.id, []]));
	for (const edge of graph.edges) {
		if (edge.kind === "FEEDBACK" || edge.from === "@input" || edge.to === "@output") continue;
		parents.get(edge.to)?.push(edge.from);
	}
	const depthOf = (id, seen = new Set()) => {
		if (depth.has(id)) return depth.get(id);
		if (seen.has(id)) return 0;
		seen.add(id);
		const upstream = parents.get(id) ?? [];
		const value = upstream.length === 0 ? 0 : 1 + Math.max(...upstream.map((parent) => depthOf(parent, new Set(seen))));
		depth.set(id, value);
		return value;
	};
	for (const node of graph.nodes) depthOf(node.id);
	const columns = new Map();
	for (const node of graph.nodes) {
		const column = depth.get(node.id) ?? 0;
		if (!columns.has(column)) columns.set(column, []);
		columns.get(column).push(node.id);
	}
	const columnCount = Math.max(...columns.keys()) + 1;
	const maxRows = Math.max(...[...columns.values()].map((items) => items.length));
	const height = Math.max(maxRows * (NODE_H + GAP_Y) - GAP_Y + PAD * 2, 360);
	const width = Math.max(PAD * 2 + columnCount * NODE_W + (columnCount - 1) * GAP_X + 80, 760);
	const pos = new Map();
	for (const [column, ids] of columns) {
		const columnHeight = ids.length * (NODE_H + GAP_Y) - GAP_Y;
		ids.forEach((id, index) => pos.set(id, {
			x: PAD + 40 + column * (NODE_W + GAP_X),
			y: (height - columnHeight) / 2 + index * (NODE_H + GAP_Y),
		}));
	}
	return { pos, width, height };
}

function currentLayout() {
	const automatic = autoLayout(S.graph);
	if (S.view !== "edit" || !S.editor) return automatic;
	const pos = new Map();
	for (const node of S.editor.graph.nodes) {
		const saved = S.editor.ui.positions[node.id];
		const point = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : automatic.pos.get(node.id);
		const normalized = point ?? { x: PAD + 40, y: PAD + 20 };
		pos.set(node.id, { ...normalized });
		S.editor.ui.positions[node.id] = { ...normalized };
	}
	const maxX = Math.max(0, ...[...pos.values()].map((point) => point.x + NODE_W));
	const maxY = Math.max(0, ...[...pos.values()].map((point) => point.y + NODE_H));
	return {
		pos,
		width: Math.max(automatic.width, maxX + PAD + 70),
		height: Math.max(automatic.height, maxY + PAD),
	};
}

function clearDag() {
	$("dag").innerHTML = "";
	$("canvasEmpty").style.display = "";
	S.els.clear();
	S.edgeEls = [];
	S.renderLayout = null;
}

const svgEl = (tag, attrs = {}) => {
	const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
	return element;
};

function renderDag() {
	if (!S.graph) return clearDag();
	const svg = $("dag");
	svg.innerHTML = "";
	S.els.clear();
	S.edgeEls = [];
	const layout = currentLayout();
	S.renderLayout = layout;
	const { pos, width, height } = layout;
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("height", Math.max(360, Math.min(height, 720)));
	$("canvasEmpty").style.display = S.graph.nodes.length === 0 ? "" : "none";

	const defs = svgEl("defs");
	const marker = svgEl("marker", { id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "5", markerHeight: "5", orient: "auto-start-reverse" });
	marker.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "arrow-head" }));
	defs.appendChild(marker);
	svg.appendChild(defs);

	for (const edge of S.graph.edges) {
		const path = svgEl("path", {
			d: edgePath(edge, layout),
			class: `edge${edge.kind === "FEEDBACK" ? " feedback" : ""}${S.editor?.selected?.type === "edge" && S.editor.selected.id === edge.id ? " selected" : ""}`,
			"data-edge-id": edge.id,
			"marker-end": edge.kind === "FEEDBACK" ? "" : "url(#arrow)",
		});
		if (S.view === "edit") path.addEventListener("click", (event) => {
			event.stopPropagation();
			selectEditorElement({ type: "edge", id: edge.id });
		});
		svg.appendChild(path);
		S.edgeEls.push({ el: path, edgeId: edge.id });
	}

	renderGraphBoundaryPort(svg, "@input", "source", boundaryAnchor("@input", layout), "in");
	renderGraphBoundaryPort(svg, "@output", "target", boundaryAnchor("@output", layout), "out");

	for (const node of S.graph.nodes) {
		const point = pos.get(node.id);
		if (!point) continue;
		const runtime = S.nodes.get(node.id);
		const state = S.view === "edit" ? "editing" : runtime?.state ?? "waiting";
		const selected = S.editor?.selected?.type === "node" && S.editor.selected.id === node.id;
		const group = svgEl("g", {
			class: `node ${state}${selected ? " selected" : ""}`,
			transform: `translate(${point.x},${point.y})`,
			"data-id": node.id,
		});
		group.appendChild(svgEl("rect", { class: "card", width: NODE_W, height: NODE_H, rx: 10 }));
		const name = svgEl("text", { x: 12, y: 22, class: "n-name" });
		name.textContent = node.id;
		const sub = svgEl("text", { x: 12, y: 39, class: "n-sub" });
		sub.textContent = `${node.kind} · ${node.agentCard}`;
		const status = svgEl("text", { x: 12, y: 57, class: "n-status" });
		status.textContent = S.view === "edit" ? "✎ drag · click to edit" : `○ ${state}`;
		const count = svgEl("text", { x: NODE_W - 12, y: 57, class: "n-count", "text-anchor": "end" });
		group.append(name, sub, status, count);
		if (S.view === "edit") {
			const input = svgEl("circle", { cx: 0, cy: NODE_H / 2, r: 7, class: "node-port target-port", "data-port-node": node.id, "data-port-role": "target" });
			const output = svgEl("circle", { cx: NODE_W, cy: NODE_H / 2, r: 7, class: `node-port source-port${S.editor.connectingFrom === node.id ? " active" : ""}`, "data-port-node": node.id, "data-port-role": "source" });
			input.addEventListener("click", handlePortClick);
			output.addEventListener("click", handlePortClick);
			group.append(input, output);
			group.addEventListener("pointerdown", (event) => startNodeDrag(event, node.id));
			group.addEventListener("click", (event) => {
				if (event.target.closest(".node-port")) return;
				event.stopPropagation();
				if (S.justDragged) return;
				selectEditorElement({ type: "node", id: node.id });
			});
		} else {
			group.addEventListener("click", () => openRuntimeDetail(node.id));
		}
		svg.appendChild(group);
		S.els.set(node.id, { g: group, status, count });
	}
	if (S.view === "run") refreshRuntimeEdges();
}

function boundaryAnchor(id, layout) {
	return id === "@input"
		? { x: 30, y: layout.height / 2 }
		: { x: layout.width - 30, y: layout.height / 2 };
}

function nodeAnchor(id, side, layout) {
	if (id === "@input" || id === "@output") return boundaryAnchor(id, layout);
	const point = layout.pos.get(id) ?? { x: 0, y: 0 };
	return side === "out"
		? { x: point.x + NODE_W, y: point.y + NODE_H / 2 }
		: { x: point.x, y: point.y + NODE_H / 2 };
}

function edgePath(edge, layout) {
	if (edge.kind === "FEEDBACK") {
		const source = nodeAnchor(edge.from, "out", layout);
		const target = nodeAnchor(edge.to, "in", layout);
		const dip = Math.max(source.y, target.y) + 64;
		return `M ${source.x} ${source.y} C ${source.x + 24} ${dip}, ${target.x - 24} ${dip}, ${target.x} ${target.y}`;
	}
	const source = nodeAnchor(edge.from, "out", layout);
	const target = nodeAnchor(edge.to, "in", layout);
	const dx = Math.max(30, Math.abs(target.x - source.x) * 0.42);
	return `M ${source.x} ${source.y} C ${source.x + dx} ${source.y}, ${target.x - dx} ${target.y}, ${target.x} ${target.y}`;
}

function renderGraphBoundaryPort(svg, id, role, point, label) {
	const circle = svgEl("circle", {
		cx: point.x, cy: point.y, r: S.view === "edit" ? 8 : 4,
		class: `port graph-port ${role}-port${S.editor?.connectingFrom === id ? " active" : ""}`,
		"data-port-node": id, "data-port-role": role,
	});
	if (S.view === "edit") circle.addEventListener("click", handlePortClick);
	svg.appendChild(circle);
	const text = svgEl("text", { x: point.x, y: point.y - 13, "text-anchor": "middle", class: "port-label" });
	text.textContent = label;
	svg.appendChild(text);
}

function handlePortClick(event) {
	if (!S.editor) return;
	event.stopPropagation();
	const role = event.currentTarget.dataset.portRole;
	const nodeId = event.currentTarget.dataset.portNode;
	if (role === "source") {
		S.editor.connectMode = true;
		S.editor.connectingFrom = nodeId;
		updateEditorNotice();
		renderDag();
		return;
	}
	if (!S.editor.connectingFrom) {
		showEditorNotice("Choose a source output port first", "warn");
		return;
	}
	const source = S.editor.connectingFrom;
	if (source === nodeId) {
		showEditorNotice("Source and target must be different", "warn");
		return;
	}
	const result = addEdge(S.editor.graph, { from: source, to: nodeId, kind: "DATA" });
	S.editor.graph = result.graph;
	S.editor.selected = { type: "edge", id: result.id };
	S.editor.connectingFrom = null;
	S.editor.connectMode = false;
	editorChanged();
}

function svgPoint(event) {
	const svg = $("dag");
	const point = svg.createSVGPoint();
	point.x = event.clientX;
	point.y = event.clientY;
	return point.matrixTransform(svg.getScreenCTM().inverse());
}

function startNodeDrag(event, nodeId) {
	if (S.view !== "edit" || !S.editor || event.button !== 0 || event.target.closest(".node-port")) return;
	const point = svgPoint(event);
	const position = S.editor.ui.positions[nodeId];
	S.drag = { nodeId, dx: point.x - position.x, dy: point.y - position.y, moved: false };
	event.preventDefault();
}

function moveNodeDrag(event) {
	if (!S.drag || !S.editor || !S.renderLayout) return;
	const point = svgPoint(event);
	const x = Math.max(46, Math.min(S.renderLayout.width - NODE_W - 46, point.x - S.drag.dx));
	const y = Math.max(20, Math.min(S.renderLayout.height - NODE_H - 20, point.y - S.drag.dy));
	S.editor.ui.positions[S.drag.nodeId] = { x, y };
	S.renderLayout.pos.set(S.drag.nodeId, { x, y });
	S.drag.moved = true;
	updateEditorGeometry();
}

function endNodeDrag() {
	if (!S.drag) return;
	const moved = S.drag.moved;
	S.drag = null;
	if (moved) {
		S.justDragged = true;
		setTimeout(() => { S.justDragged = false; }, 0);
		editorChanged();
	}
}

function updateEditorGeometry() {
	if (!S.renderLayout || !S.editor) return;
	for (const [nodeId, element] of S.els) {
		const point = S.renderLayout.pos.get(nodeId);
		if (point) element.g.setAttribute("transform", `translate(${point.x},${point.y})`);
	}
	for (const item of S.edgeEls) {
		const edge = S.editor.graph.edges.find((candidate) => candidate.id === item.edgeId);
		if (edge) item.el.setAttribute("d", edgePath(edge, S.renderLayout));
	}
}

// ---- editor inspector ---------------------------------------------------------

function openEditorInspector() {
	if (!S.editor?.selected) return closeDetail();
	const { type, id } = S.editor.selected;
	if (type === "node") renderNodeInspector(id);
	else if (type === "edge") renderEdgeInspector(id);
	else renderLoopInspector(id);
}

function renderNodeInspector(nodeId) {
	const node = S.editor.graph.nodes.find((item) => item.id === nodeId);
	if (!node) return closeDetail();
	showDetail(`node · ${node.id}`, `
		<form id="nodeInspectorForm" class="inspector-form">
			<label class="field"><span class="field-label">Node id</span><input id="iNodeId" type="text" value="${escapeAttr(node.id)}" /></label>
			<label class="field"><span class="field-label">Kind</span><select id="iNodeKind">${options(["planner", "worker", "verifier", "aggregator"], node.kind)}</select></label>
			<label class="field"><span class="field-label">Agent card</span><select id="iNodeCard">${options([...S.installedCards.keys()], node.agentCard)}</select></label>
			<label class="field"><span class="field-label">Trigger</span><select id="iNodeTrigger">${options(["ALL_SUCCESS", "ANY_SUCCESS"], node.trigger)}</select></label>
			<label class="check-field"><input id="iNodeHandoff" type="checkbox" ${node.controlHandoff ? "checked" : ""} /> controlHandoff</label>
			<label class="field"><span class="field-label">Prompt template</span><textarea id="iNodePrompt" rows="10">${escapeHtml(node.promptTemplate)}</textarea></label>
			<div class="detail-section">Per-node budget (blank = inherit)</div>
			<div class="number-grid">
				<label><span>tokens</span><input id="iBudgetTokens" type="number" min="1" value="${node.budget?.maxTokens ?? ""}" /></label>
				<label><span>wall ms</span><input id="iBudgetWall" type="number" min="1" value="${node.budget?.maxWallTimeMs ?? ""}" /></label>
				<label><span>money µ</span><input id="iBudgetMoney" type="number" min="0" value="${node.budget?.maxMonetaryMicrounits ?? ""}" /></label>
			</div>
			<button class="primary-btn" type="submit">Apply node</button>
		</form>`);
	$("nodeInspectorForm").addEventListener("submit", (event) => {
		event.preventDefault();
		const newId = $("iNodeId").value.trim();
		const budget = compactBudget({
			maxTokens: numberOrUndefined($("iBudgetTokens").value),
			maxWallTimeMs: numberOrUndefined($("iBudgetWall").value),
			maxMonetaryMicrounits: numberOrUndefined($("iBudgetMoney").value),
		});
		try {
			S.editor.graph = updateNode(S.editor.graph, nodeId, {
				id: newId,
				kind: $("iNodeKind").value,
				agentCard: $("iNodeCard").value,
				trigger: $("iNodeTrigger").value,
				controlHandoff: $("iNodeHandoff").checked,
				promptTemplate: $("iNodePrompt").value,
				budget: Object.keys(budget).length ? budget : null,
			});
			if (newId !== nodeId) {
				S.editor.ui.positions[newId] = S.editor.ui.positions[nodeId];
				delete S.editor.ui.positions[nodeId];
				S.editor.selected.id = newId;
			}
			editorChanged();
		} catch (error) { showEditorNotice(error.message, "err"); }
	});
}

function renderEdgeInspector(edgeId) {
	const edge = S.editor.graph.edges.find((item) => item.id === edgeId);
	if (!edge) return closeDetail();
	const from = ["@input", ...S.editor.graph.nodes.map((node) => node.id)];
	const to = [...S.editor.graph.nodes.map((node) => node.id), "@output"];
	showDetail(`edge · ${edge.id}`, `
		<form id="edgeInspectorForm" class="inspector-form">
			<label class="field"><span class="field-label">Edge id</span><input id="iEdgeId" type="text" value="${escapeAttr(edge.id)}" /></label>
			<label class="field"><span class="field-label">From</span><select id="iEdgeFrom">${options(from, edge.from)}</select></label>
			<label class="field"><span class="field-label">To</span><select id="iEdgeTo">${options(to, edge.to)}</select></label>
			<label class="field"><span class="field-label">Kind</span><select id="iEdgeKind">${options(["DATA", "CONTROL", "FEEDBACK"], edge.kind)}</select></label>
			<label class="field"><span class="field-label">Loop</span><select id="iEdgeLoop"><option value="">none / create automatically</option>${options(S.editor.graph.loops.map((loop) => loop.id), edge.loopId ?? "")}</select></label>
			<button class="primary-btn" type="submit">Apply edge</button>
		</form>`);
	$("edgeInspectorForm").addEventListener("submit", (event) => {
		event.preventDefault();
		try {
			const newId = $("iEdgeId").value.trim();
			const kind = $("iEdgeKind").value;
			const fromValue = $("iEdgeFrom").value;
			const toValue = $("iEdgeTo").value;
			if (kind === "FEEDBACK" && (fromValue === "@input" || toValue === "@output")) {
				throw new Error("FEEDBACK must connect two workflow nodes");
			}
			let loopId = $("iEdgeLoop").value || null;
			S.editor.graph = updateEdge(S.editor.graph, edgeId, {
				id: newId, from: fromValue, to: toValue, kind, loopId,
			});
			if (kind === "FEEDBACK" && !loopId) {
				const changed = S.editor.graph.edges.find((item) => item.id === newId);
				const created = addLoop(S.editor.graph, {
					bodyNodes: [...new Set([changed.to, changed.from])], feedbackEdges: [newId], maxIterations: 2,
				});
				S.editor.graph = bindFeedbackEdge(created.graph, newId, created.id);
				loopId = created.id;
			} else if (kind === "FEEDBACK") {
				S.editor.graph = bindFeedbackEdge(S.editor.graph, newId, loopId);
			}
			S.editor.selected.id = newId;
			editorChanged();
		} catch (error) { showEditorNotice(error.message, "err"); }
	});
}

function renderLoopInspector(loopId) {
	const loop = S.editor.graph.loops.find((item) => item.id === loopId);
	if (!loop) return closeDetail();
	showDetail(`loop · ${loop.id}`, `
		<form id="loopInspectorForm" class="inspector-form">
			<label class="field"><span class="field-label">Loop id</span><input id="iLoopId" type="text" value="${escapeAttr(loop.id)}" /></label>
			<label class="field"><span class="field-label">Max iterations</span><input id="iLoopMax" type="number" min="1" max="20" value="${loop.maxIterations}" /></label>
			<div class="detail-section">Body nodes</div>
			<div class="check-list">${S.editor.graph.nodes.map((node) => checkbox("loopBody", node.id, loop.bodyNodes.includes(node.id))).join("")}</div>
			<div class="detail-section">Feedback edges</div>
			<div class="check-list">${S.editor.graph.edges.map((edge) => checkbox("loopEdge", edge.id, loop.feedbackEdges.includes(edge.id), `${edge.id}: ${edge.from} → ${edge.to}`)).join("")}</div>
			<button class="primary-btn" type="submit">Apply loop</button>
		</form>`);
	$("loopInspectorForm").addEventListener("submit", (event) => {
		event.preventDefault();
		try {
			const newId = $("iLoopId").value.trim();
			S.editor.graph = updateLoop(S.editor.graph, loopId, {
				id: newId,
				maxIterations: Number($("iLoopMax").value),
				bodyNodes: checkedValues("loopBody"),
				feedbackEdges: checkedValues("loopEdge"),
			});
			S.editor.selected.id = newId;
			editorChanged();
		} catch (error) { showEditorNotice(error.message, "err"); }
	});
}

function showDetail(title, body) {
	$("detail").hidden = false;
	$("detail").style.display = "";
	$("detailTitle").textContent = title;
	$("detailBody").innerHTML = body;
}

function options(values, selected) {
	return values.map((value) => `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
}

function checkbox(name, value, checked, label = value) {
	return `<label class="check-field"><input type="checkbox" name="${escapeAttr(name)}" value="${escapeAttr(value)}" ${checked ? "checked" : ""} /> ${escapeHtml(label)}</label>`;
}

function checkedValues(name) {
	return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((element) => element.value);
}

function numberOrUndefined(value) {
	if (value === "") return undefined;
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function compactBudget(budget) {
	return Object.fromEntries(Object.entries(budget).filter(([, value]) => value !== undefined));
}

// ---- runtime detail / stats ---------------------------------------------------

function updateNodeEl(id) {
	const element = S.els.get(id);
	const node = S.nodes.get(id);
	if (!element || !node) return;
	element.g.setAttribute("class", `node ${node.state}`);
	const attempt = node.attemptNo > 1 ? ` ·${node.attemptNo}` : "";
	element.status.textContent = `${STATE_ICON[node.state] ?? "○"} ${node.state}${attempt}`;
	element.count.textContent = node.tokens > 0 || node.tools > 0 ? `⚒${node.tools} Σ${fmtTok(node.tokens)}` : "";
}

function refreshRuntimeEdges() {
	for (const item of S.edgeEls) {
		const edge = S.graph?.edges.find((candidate) => candidate.id === item.edgeId);
		if (!edge || edge.kind === "FEEDBACK") continue;
		const source = S.nodes.get(edge.from);
		const target = S.nodes.get(edge.to);
		let cls = "edge";
		if (source?.state === "succeeded" && target?.state === "running") cls = "edge active";
		else if (source?.state === "succeeded" || edge.from === "@input") cls = edge.to === "@output" ? "edge" : "edge done";
		if (edge.from === "@input" && target?.state === "running") cls = "edge active";
		item.el.setAttribute("class", cls);
	}
}

function updateStats() {
	$("statTokens").textContent = fmtTok(S.totals.tokens);
	$("statCost").textContent = fmtCost(S.totals.cost);
	const total = S.nodes.size;
	const done = [...S.nodes.values()].filter((node) => node.state === "succeeded" || node.state === "failed").length;
	$("statNodes").textContent = total ? `${done}/${total}` : "—";
}

function setChip(state, label) {
	const chip = $("runChip");
	chip.dataset.state = state === "success" ? "success" : state === "failure" || state === "failed" ? "failure" : state;
	$("chipIcon").textContent = state === "running" ? "◐" : state === "success" ? "✓" : state === "failure" ? "✕" : "○";
	$("chipLabel").textContent = label;
}

function feed(nodeId, message, cls = "") {
	const box = $("feed");
	const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
	const line = document.createElement("div");
	line.className = `feed-line ${cls}`;
	line.innerHTML = `<span class="feed-time">${now()}</span><span class="feed-node">${escapeHtml(nodeId || "")}</span><span class="feed-msg"></span>`;
	line.querySelector(".feed-msg").textContent = message;
	box.appendChild(line);
	while (box.children.length > 400) box.firstChild.remove();
	if (atBottom) box.scrollTop = box.scrollHeight;
}

function openRuntimeDetail(id) {
	const node = S.nodes.get(id);
	if (!node) return;
	S.detailNode = id;
	const card = S.runtimeCards[node.card];
	const activities = node.acts.slice(-20).map((activity) => `<div>${escapeHtml(activity)}</div>`).join("");
	showDetail(id, `
		<dl class="kv">
			<dt>status</dt><dd><span class="status-inline ${node.state}">${STATE_ICON[node.state]} ${node.state}</span></dd>
			<dt>attempt</dt><dd>${node.attemptNo}</dd>
			<dt>role</dt><dd>${escapeHtml(node.kind)}</dd>
			<dt>agent card</dt><dd>${escapeHtml(node.card)}</dd>
			<dt>tools used</dt><dd>${node.tools}</dd>
			<dt>tokens</dt><dd>${fmtTok(node.tokens)}</dd>
			<dt>cost</dt><dd>${fmtCost(node.cost)}</dd>
		</dl>
		${card ? `<div class="detail-section">division of labor</div><p class="detail-copy">${escapeHtml(card.description)}</p><p class="detail-muted">tools: ${card.tools.join(", ")}</p>` : ""}
		${activities ? `<div class="detail-section">recent activity</div><div class="act-list">${activities}</div>` : ""}
		${node.error ? `<div class="detail-section">error</div><div class="out-json error-text">${escapeHtml(node.error)}</div>` : ""}
		${node.output ? `<div class="detail-section">output</div><div class="out-json">${escapeHtml(JSON.stringify(node.output, null, 2))}</div>` : ""}`);
}

function closeDetail() {
	S.detailNode = null;
	if (S.view === "edit" && S.editor) {
		S.editor.selected = null;
		updateDeleteButton();
		renderDag();
	}
	$("detail").hidden = true;
	$("detail").style.display = "none";
}

boot().catch((error) => {
	setChip("failure", "GUI initialization failed");
	feed("", error.message, "err");
});
