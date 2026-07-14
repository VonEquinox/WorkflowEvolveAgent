/* WEA GUI — vanilla ES module. Talks to gui-server.ts:
   templates → preview DAG; POST /api/run → SSE stream → live DAG/feed/stats. */

const $ = (id) => document.getElementById(id);

const NODE_W = 176, NODE_H = 64, GAP_X = 72, GAP_Y = 26, PAD = 56;

const STATE_MAP = {
	DECLARED: "waiting", WAITING_DEPS: "waiting", READY: "ready",
	RUNNING: "running", SUCCEEDED: "succeeded", FAILED: "failed",
	CANCELLED: "failed", SKIPPED: "waiting",
};
const STATE_ICON = { waiting: "○", ready: "◔", running: "◐", succeeded: "✓", failed: "✕" };

const S = {
	templates: new Map(),
	graph: null,
	cards: {},
	nodes: new Map(),      // id -> {state, attemptNo, tokens, cost, tools, acts, output, error, summary, kind, card}
	els: new Map(),        // id -> {g, status, count, rect}
	edgeEls: [],           // {el, from, to, kind}
	runStatus: "idle",
	startedAt: null,
	timer: null,
	totals: { tokens: 0, cost: 0 },
	es: null,
	detailNode: null,
	liveAvailable: false,
	mode: "sim",
};

// ---- formatting ----------------------------------------------------------------

const fmtTok = (n) => (n >= 1000 ? n.toLocaleString("en-US") : String(n));
const fmtCost = (micro) => "$" + (micro / 1e6).toFixed(4);
const now = () => new Date().toTimeString().slice(0, 8);
const fmtElapsed = (ms) => {
	const s = Math.floor(ms / 1000);
	return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

// ---- boot ----------------------------------------------------------------------

async function boot() {
	const health = await fetch("/api/health").then((r) => r.json()).catch(() => ({ liveAvailable: false }));
	S.liveAvailable = !!health.liveAvailable;
	if (!S.liveAvailable) {
		$("liveBtn").disabled = true;
		$("modeHint").textContent = "simulate: full scheduling demo, no endpoint, no spend · live disabled (no WEA_* env)";
	}

	const data = await fetch("/api/templates").then((r) => r.json());
	const sel = $("template");
	for (const t of data.templates) {
		S.templates.set(t.id, t);
		const opt = document.createElement("option");
		opt.value = t.id;
		opt.textContent = `${t.id} — ${t.summary.split(":")[0].replace(/^T\d+\s*/, "").trim() || t.id}`;
		sel.appendChild(opt);
	}

	sel.addEventListener("change", () => previewTemplate(sel.value));
	$("modeSeg").addEventListener("click", (ev) => {
		const btn = ev.target.closest(".seg-btn");
		if (!btn || btn.disabled) return;
		S.mode = btn.dataset.mode;
		for (const b of $("modeSeg").children) b.classList.toggle("selected", b === btn);
	});
	$("runForm").addEventListener("submit", startRun);
	$("detailClose").addEventListener("click", closeDetail);
	previewTemplate("auto");
}

// ---- template preview ------------------------------------------------------------

function previewTemplate(ref) {
	if (S.runStatus === "running") return;
	if (ref === "auto") {
		$("graphTitle").textContent = "auto — retrieval picks the workflow at run time";
		$("graphMeta").textContent = "";
		clearDag();
		return;
	}
	const t = S.templates.get(ref);
	if (!t) return;
	initGraph(t.graph, {});
	$("graphTitle").textContent = `${t.id} @ ${t.version}`;
	$("graphMeta").textContent = `${t.graph.nodes.length} nodes · preview`;
	renderDag();
}

// ---- run lifecycle ----------------------------------------------------------------

async function startRun(ev) {
	ev.preventDefault();
	if (S.runStatus === "running") return;
	const body = {
		task: $("task").value.trim(),
		template: $("template").value,
		repo: $("repo").value.trim() || undefined,
		mode: S.mode,
	};
	if (!body.task) return;

	$("runBtn").disabled = true;
	setChip("running", "starting…");
	feed("", "POST /api/run …");

	let resp;
	try {
		resp = await fetch("/api/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}).then((r) => r.json());
	} catch (e) {
		setChip("failure", "server unreachable");
		$("runBtn").disabled = false;
		return;
	}
	if (!resp.runId) {
		setChip("failure", resp.error || "failed to start");
		feed("", `error: ${resp.error || "failed to start"}`, "err");
		$("runBtn").disabled = false;
		return;
	}

	S.es = new EventSource(`/api/run/${resp.runId}/events`);
	S.es.onmessage = (m) => handleEvent(JSON.parse(m.data));
	S.es.onerror = () => { if (S.runStatus !== "running") S.es?.close(); };
}

function handleEvent(e) {
	switch (e.type) {
		case "template_resolved":
			feed("", e.why);
			break;

		case "run_started": {
			S.runStatus = "running";
			S.totals = { tokens: 0, cost: 0 };
			S.startedAt = Date.now();
			S.cards = e.cards;
			initGraph(e.graph, e.cards);
			renderDag();
			$("graphTitle").textContent = `${e.templateRef} @ ${e.templateVersion}`;
			$("graphMeta").textContent = `${e.graph.nodes.length} nodes · ${e.mode} · run ${e.runId.slice(0, 8)}`;
			setChip("running", e.mode === "sim" ? "simulating" : "running");
			clearInterval(S.timer);
			S.timer = setInterval(() => { $("statElapsed").textContent = fmtElapsed(Date.now() - S.startedAt); }, 500);
			updateStats();
			feed("", `run started: ${e.templateRef} (${e.mode})`);
			break;
		}

		case "node_state": {
			const n = S.nodes.get(e.nodeId);
			if (!n) break;
			n.state = STATE_MAP[e.state] ?? "waiting";
			n.attemptNo = e.attemptNo;
			if (n.state === "failed" && e.detail) { n.error = e.detail; feed(e.nodeId, e.detail, "err"); }
			updateNodeEl(e.nodeId);
			refreshEdges();
			updateStats();
			if (S.detailNode === e.nodeId) openDetail(e.nodeId);
			break;
		}

		case "node_activity": {
			const n = S.nodes.get(e.nodeId);
			if (!n) break;
			const a = e.activity;
			let line = "";
			if (a.kind === "tool_call") { n.tools += 1; line = `▸ ${a.tool} ${a.detail}`; }
			else if (a.kind === "tool_result") line = `${a.isError ? "✕" : "·"} ${a.tool} → ${a.chars.toLocaleString()} chars`;
			else if (a.kind === "llm") {
				n.tokens += a.inputTokens + a.outputTokens;
				n.cost += a.costMicrounits;
				line = `Σ +${fmtTok(a.inputTokens + a.outputTokens)} tok · ${fmtCost(a.costMicrounits)}`;
			}
			n.acts.push(line);
			if (n.acts.length > 60) n.acts.shift();
			feed(e.nodeId, line, a.kind === "tool_result" && a.isError ? "err" : "");
			updateNodeEl(e.nodeId);
			if (S.detailNode === e.nodeId) openDetail(e.nodeId);
			break;
		}

		case "node_result": {
			const n = S.nodes.get(e.nodeId);
			if (!n) break;
			n.summary = e.summary; n.output = e.output; n.error = e.error;
			n.tokens = e.tokens; n.cost = e.costMicrounits; n.tools = e.toolCalls;
			feed(e.nodeId, e.status === "success" ? `✓ ${e.summary}` : `✕ ${e.error}`, e.status === "success" ? "ok" : "err");
			if (S.detailNode === e.nodeId) openDetail(e.nodeId);
			break;
		}

		case "loop":
			feed("", e.exhausted ? `loop ${e.loopId} exhausted (iteration ${e.iteration})` : `loop ${e.loopId} → iteration ${e.iteration}`, "warn");
			break;

		case "budget":
			S.totals.tokens = e.tokensUsed;
			S.totals.cost = e.costMicrounits;
			updateStats();
			break;

		case "log":
			feed("", e.message);
			break;

		case "run_done": {
			S.runStatus = e.status;
			clearInterval(S.timer);
			setChip(e.status, e.status === "success" ? "success" : "failed");
			S.totals.tokens = e.tokens;
			S.totals.cost = e.costMicrounits;
			updateStats();
			feed("", `run done: ${e.status} · ${fmtTok(e.tokens)} tok · ${fmtCost(e.costMicrounits)}`, e.status === "success" ? "ok" : "err");
			for (const f of e.files) feed("", `wrote ${f.split("/").pop()}`);
			$("runBtn").disabled = false;
			S.es?.close();
			break;
		}
	}
}

// ---- graph state ------------------------------------------------------------------

function initGraph(graph, cards) {
	S.graph = graph;
	S.nodes.clear();
	for (const n of graph.nodes) {
		S.nodes.set(n.id, {
			state: "waiting", attemptNo: 1, tokens: 0, cost: 0, tools: 0,
			acts: [], output: null, error: null, summary: "",
			kind: n.kind, card: n.agentCard,
		});
	}
}

// ---- DAG layout + render ------------------------------------------------------------

function layout(graph) {
	const depth = new Map();
	const parents = new Map(graph.nodes.map((n) => [n.id, []]));
	for (const e of graph.edges) {
		if (e.kind === "FEEDBACK" || e.from === "@input" || e.to === "@output") continue;
		parents.get(e.to)?.push(e.from);
	}
	const d = (id, seen = new Set()) => {
		if (depth.has(id)) return depth.get(id);
		if (seen.has(id)) return 0;
		seen.add(id);
		const ps = parents.get(id) ?? [];
		const v = ps.length === 0 ? 0 : 1 + Math.max(...ps.map((p) => d(p, seen)));
		depth.set(id, v);
		return v;
	};
	for (const n of graph.nodes) d(n.id);

	const cols = new Map();
	for (const n of graph.nodes) {
		const c = depth.get(n.id) ?? 0;
		if (!cols.has(c)) cols.set(c, []);
		cols.get(c).push(n.id);
	}
	const nCols = Math.max(...cols.keys()) + 1;
	const maxRows = Math.max(...[...cols.values()].map((v) => v.length));
	const height = Math.max(maxRows * (NODE_H + GAP_Y) - GAP_Y + PAD * 2, 260);
	const width = PAD * 2 + nCols * NODE_W + (nCols - 1) * GAP_X + 40;

	const pos = new Map();
	for (const [c, ids] of cols) {
		const colH = ids.length * (NODE_H + GAP_Y) - GAP_Y;
		ids.forEach((id, i) => {
			pos.set(id, {
				x: PAD + 20 + c * (NODE_W + GAP_X),
				y: (height - colH) / 2 + i * (NODE_H + GAP_Y),
			});
		});
	}
	return { pos, width, height };
}

function clearDag() {
	$("dag").innerHTML = "";
	$("canvasEmpty").style.display = "";
	S.els.clear();
	S.edgeEls = [];
}

const svgEl = (tag, attrs = {}) => {
	const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	return el;
};

function renderDag() {
	const svg = $("dag");
	svg.innerHTML = "";
	S.els.clear();
	S.edgeEls = [];
	$("canvasEmpty").style.display = "none";
	const graph = S.graph;
	const { pos, width, height } = layout(graph);
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("height", Math.min(height, 560));

	const anchor = (id, side) => {
		if (id === "@input") return { x: PAD - 22, y: height / 2 };
		if (id === "@output") return { x: width - PAD + 2, y: height / 2 };
		const p = pos.get(id);
		return side === "out"
			? { x: p.x + NODE_W, y: p.y + NODE_H / 2 }
			: { x: p.x, y: p.y + NODE_H / 2 };
	};

	// ports
	for (const [id, label, x] of [["@input", "in", PAD - 22], ["@output", "out", width - PAD + 2]]) {
		svg.appendChild(svgEl("circle", { cx: x, cy: height / 2, r: 4, class: "port" }));
		const t = svgEl("text", { x, y: height / 2 - 10, "text-anchor": "middle", class: "port-label" });
		t.textContent = label;
		svg.appendChild(t);
	}

	// edges under nodes
	for (const e of graph.edges) {
		let dpath;
		if (e.kind === "FEEDBACK") {
			const s = pos.get(e.from), t = pos.get(e.to);
			if (!s || !t) continue;
			const sx = s.x + NODE_W / 2, sy = s.y + NODE_H, tx = t.x + NODE_W / 2, ty = t.y + NODE_H;
			const dip = Math.max(sy, ty) + 46;
			dpath = `M ${sx} ${sy} C ${sx} ${dip}, ${tx} ${dip}, ${tx} ${ty}`;
		} else {
			const a = anchor(e.from, "out"), b = anchor(e.to, "in");
			const dx = Math.max(28, (b.x - a.x) * 0.45);
			dpath = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
		}
		const el = svgEl("path", { d: dpath, class: `edge${e.kind === "FEEDBACK" ? " feedback" : ""}` });
		svg.appendChild(el);
		S.edgeEls.push({ el, from: e.from, to: e.to, kind: e.kind });
	}

	// nodes
	for (const n of graph.nodes) {
		const p = pos.get(n.id);
		const g = svgEl("g", { class: "node waiting", transform: `translate(${p.x},${p.y})`, "data-id": n.id });
		g.appendChild(svgEl("rect", { class: "card", width: NODE_W, height: NODE_H, rx: 10 }));
		const name = svgEl("text", { x: 12, y: 22, class: "n-name" });
		name.textContent = n.id;
		const sub = svgEl("text", { x: 12, y: 37, class: "n-sub" });
		sub.textContent = `${n.kind} · ${n.agentCard}`;
		const status = svgEl("text", { x: 12, y: 53, class: "n-status" });
		status.textContent = "○ waiting";
		const count = svgEl("text", { x: NODE_W - 12, y: 53, class: "n-count", "text-anchor": "end" });
		g.append(name, sub, status, count);
		g.addEventListener("click", () => openDetail(n.id));
		svg.appendChild(g);
		S.els.set(n.id, { g, status, count });
	}
	refreshEdges();
}

function updateNodeEl(id) {
	const el = S.els.get(id);
	const n = S.nodes.get(id);
	if (!el || !n) return;
	el.g.setAttribute("class", `node ${n.state}`);
	const attempt = n.attemptNo > 1 ? ` ·${n.attemptNo}` : "";
	el.status.textContent = `${STATE_ICON[n.state] ?? "○"} ${n.state}${attempt}`;
	el.count.textContent = n.tokens > 0 || n.tools > 0 ? `⚒${n.tools} Σ${fmtTok(n.tokens)}` : "";
}

function refreshEdges() {
	for (const { el, from, to, kind } of S.edgeEls) {
		if (kind === "FEEDBACK") continue;
		const src = S.nodes.get(from);
		const dst = S.nodes.get(to);
		let cls = "edge";
		if (src?.state === "succeeded" && dst?.state === "running") cls = "edge active";
		else if (src?.state === "succeeded" || from === "@input") cls = to === "@output" ? "edge" : "edge done";
		if (from === "@input" && dst?.state === "running") cls = "edge active";
		el.setAttribute("class", cls);
	}
}

// ---- stats / chip / feed ------------------------------------------------------------

function updateStats() {
	$("statTokens").textContent = fmtTok(S.totals.tokens);
	$("statCost").textContent = fmtCost(S.totals.cost);
	const total = S.nodes.size;
	const done = [...S.nodes.values()].filter((n) => n.state === "succeeded" || n.state === "failed").length;
	$("statNodes").textContent = total ? `${done}/${total}` : "—";
}

function setChip(state, label) {
	const chip = $("runChip");
	chip.dataset.state = state === "success" ? "success" : state === "failure" || state === "failed" ? "failure" : state;
	$("chipIcon").textContent = state === "running" ? "◐" : state === "success" ? "✓" : state === "failure" ? "✕" : "○";
	$("chipLabel").textContent = label;
}

function feed(nodeId, msg, cls = "") {
	const box = $("feed");
	const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
	const line = document.createElement("div");
	line.className = `feed-line ${cls}`;
	line.innerHTML = `<span class="feed-time">${now()}</span><span class="feed-node">${nodeId || ""}</span><span class="feed-msg"></span>`;
	line.querySelector(".feed-msg").textContent = msg;
	box.appendChild(line);
	while (box.children.length > 400) box.firstChild.remove();
	if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---- detail drawer -------------------------------------------------------------------

function openDetail(id) {
	const n = S.nodes.get(id);
	if (!n) return;
	S.detailNode = id;
	$("detail").hidden = false;
	$("detailTitle").textContent = id;
	const card = S.cards[n.card];
	const acts = n.acts.slice(-20).map((a) => `<div>${escapeHtml(a)}</div>`).join("");
	$("detailBody").innerHTML = `
		<dl class="kv">
			<dt>status</dt><dd><span class="status-inline ${n.state}">${STATE_ICON[n.state]} ${n.state}</span></dd>
			<dt>attempt</dt><dd>${n.attemptNo}</dd>
			<dt>role</dt><dd>${n.kind}</dd>
			<dt>agent card</dt><dd>${n.card}</dd>
			<dt>tools used</dt><dd>${n.tools}</dd>
			<dt>tokens</dt><dd>${fmtTok(n.tokens)}</dd>
			<dt>cost</dt><dd>${fmtCost(n.cost)}</dd>
		</dl>
		${card ? `<div class="detail-section">division of labor</div><p style="margin:0;color:var(--ink-2)">${escapeHtml(card.description)}</p><p style="margin:6px 0 0;color:var(--muted);font-size:12px">tools: ${card.tools.join(", ")}</p>` : ""}
		${acts ? `<div class="detail-section">recent activity</div><div class="act-list">${acts}</div>` : ""}
		${n.error ? `<div class="detail-section">error</div><div class="out-json" style="color:var(--critical)">${escapeHtml(n.error)}</div>` : ""}
		${n.output ? `<div class="detail-section">output</div><div class="out-json">${escapeHtml(JSON.stringify(n.output, null, 2))}</div>` : ""}
	`;
}

function closeDetail() {
	S.detailNode = null;
	$("detail").hidden = true;
}

const escapeHtml = (s) =>
	String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

boot();
