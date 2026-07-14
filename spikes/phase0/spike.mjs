/**
 * Phase 0 spike — validate pi SDK as host for WEA multi-node orchestration.
 *
 * Goal: prove the runner-critical mechanics on the real SDK + real endpoint,
 * and answer the five open unknowns in PI_INTEGRATION_PLAN.md §8:
 *   U1 per-node custom system prompt channel
 *      (channel under test: DefaultResourceLoader#systemPromptOverride)
 *   U2 inMemory session + appendEntry behavior (recorder persistence)
 *      (real API: pi.appendEntry(customType, data) — sync, on the ExtensionAPI
 *       object; verified by reading entries back via SessionManager.getEntries())
 *   U3 parallel AgentSessions sharing one AuthStorage/ModelRegistry
 *   U4 node structured JSON output mechanism
 *   U5 tool_call/tool_result events carry enough for read-set (path + digest?)
 *      (source says: *ToolDetails have truncation info only, NO content digest;
 *       this spike dumps one live tool_result to confirm the wire shape)
 *
 * Shape: one planner node runs first (read-only tools) and emits a JSON plan;
 * two worker nodes then run in parallel, each with its own system prompt,
 * tool allowlist, inMemory session, and a recorder inline-extension that
 * captures tool_call inputs (read/grep/... file paths) + per-LLM usage.
 *
 * Run:
 *   WEA_BASE_URL=... WEA_API_KEY=... WEA_MODEL=... node spike.mjs
 */

import {
	AuthStorage,
	ModelRegistry,
	SessionManager,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

const BASE_URL = process.env.WEA_BASE_URL;
const API_KEY = process.env.WEA_API_KEY;
const MODEL_ID = process.env.WEA_MODEL;
if (!BASE_URL || !API_KEY || !MODEL_ID) {
	console.error("set WEA_BASE_URL / WEA_API_KEY / WEA_MODEL");
	process.exit(1);
}

// ---- U3: one shared AuthStorage + ModelRegistry across all nodes -----------
const auth = AuthStorage.create("/tmp/wea-spike-auth.json");
auth.setRuntimeApiKey("anthropic", API_KEY);
const registry = ModelRegistry.inMemory(auth);
const baseModel = registry.getAll().find((m) => m.provider === "anthropic" && m.id === "claude-sonnet-5");
const model = { ...baseModel, id: MODEL_ID, baseUrl: BASE_URL };

/**
 * A recorder inline-extension: captures every tool_call (typed input incl.
 * file paths) and every finalized assistant message's usage. One recorder per
 * node; results collected into the passed `sink`.
 */
function makeRecorder(sink) {
	return (pi) => {
		pi.on("tool_call", async (event) => {
			// U5a: inspect what typed tool-call inputs actually carry.
			sink.toolCalls.push({
				tool: event.toolName,
				input: event.input,
			});
			return undefined; // never block
		});
		pi.on("tool_result", async (event) => {
			// U5b: does the result carry digest-grade info, or content/truncation only?
			const textLen = (event.content ?? [])
				.filter((c) => c.type === "text")
				.reduce((a, c) => a + c.text.length, 0);
			sink.toolResults.push({
				tool: event.toolName,
				isError: event.isError,
				contentTextChars: textLen,
				contentHead: (event.content ?? []).find((c) => c.type === "text")?.text?.slice(0, 80) ?? null,
				details: event.details ?? null,
			});
			return undefined;
		});
		pi.on("message_end", async (event) => {
			const m = event.message;
			if (m?.role === "assistant" && m.usage) {
				sink.llmCalls.push({
					input: m.usage.input,
					output: m.usage.output,
					total: m.usage.totalTokens,
					cost: m.usage.cost?.total ?? 0,
				});
			}
			return undefined;
		});
		// U2: persist a custom recorder entry via the REAL API: pi.appendEntry
		// (sync, on ExtensionAPI — NOT on ctx; the old ctx?.appendEntry?.() form
		// silently no-oped and reported a false positive).
		pi.on("agent_end", async () => {
			try {
				pi.appendEntry("wea-recorder", { marker: "recorder-marker", label: sink.label });
				sink.appendEntryCalled = true;
			} catch (err) {
				sink.appendEntryCalled = false;
				sink.appendEntryErr = String(err?.message ?? err);
			}
		});
	};
}

/** Run one node = one AgentSession run with its own prompt + tools. */
async function runNode({ label, systemPrompt, tools, task }) {
	const sink = {
		label,
		toolCalls: [],
		toolResults: [],
		llmCalls: [],
		appendEntryCalled: null,
		appendEntryPersisted: null,
	};

	// U1: per-node system prompt via DefaultResourceLoader override.
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
		extensionFactories: [makeRecorder(sink)],
	});
	await loader.reload();

	// U2: keep the sessionManager so we can read entries back after the run and
	// confirm pi.appendEntry actually persisted into the inMemory session.
	const sessionManager = SessionManager.inMemory();
	const { session } = await createAgentSession({
		model,
		authStorage: auth,
		modelRegistry: registry,
		resourceLoader: loader,
		sessionManager,
		tools, // undefined => default builtins; [] via noTools handled by caller
	});

	let finalText = "";
	session.subscribe((ev) => {
		if (ev.type === "message_end" && ev.message.role === "assistant") {
			finalText = ev.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
		}
	});

	const t0 = Date.now();
	await session.prompt(task);
	sink.latencyMs = Date.now() - t0;
	sink.finalText = finalText;
	sink.sessionId = session.sessionId;

	// U2 verification: is the appended custom entry actually in the session?
	const customEntries = sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "wea-recorder");
	sink.appendEntryPersisted = customEntries.length > 0;
	sink.appendEntrySample = customEntries[0] ?? null;

	session.dispose();
	return sink;
}

/** U4: does asking for JSON-only output yield parseable JSON? */
function tryParseJson(text) {
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const raw = (fence ? fence[1] : text).trim();
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch (e) {
		return { ok: false, error: String(e.message) };
	}
}

async function main() {
	const results = {};

	// --- Node 1: planner (read-only tools), must emit JSON plan (U4) ---------
	console.log("[planner] starting (read-only tools, JSON output contract)...");
	results.planner = await runNode({
		label: "planner",
		systemPrompt:
			"You are a planning node in a multi-agent coding system. " +
			"Inspect the current directory to understand what is here, then output ONLY a JSON object " +
			'of the form {"summary": string, "files_seen": string[], "subtasks": string[]}. ' +
			"No prose, no markdown fences, just the JSON.",
		tools: ["ls", "read", "grep", "find"], // read-only allowlist
		task: "Look at the files in the current working directory and produce the plan JSON.",
	});
	const planParsed = tryParseJson(results.planner.finalText);
	console.log(`[planner] done in ${results.planner.latencyMs}ms, tools used: ${results.planner.toolCalls.length}, JSON parse: ${planParsed.ok}`);

	// --- Nodes 2 & 3: two workers IN PARALLEL (U3 concurrency) ---------------
	console.log("[workers] launching 2 nodes in parallel...");
	const t0 = Date.now();
	const [w1, w2] = await Promise.all([
		runNode({
			label: "worker-A",
			systemPrompt: "You are worker A. You ONLY answer questions about JavaScript. Be terse.",
			tools: ["read", "ls"],
			task: "In one sentence, what does package.json in this directory declare as the package name? Use tools to check.",
		}),
		runNode({
			label: "worker-B",
			systemPrompt: "You are worker B. You ONLY summarize file counts. Be terse.",
			tools: ["ls", "find"],
			task: "How many .mjs files are in this directory? Use tools to check, then answer with just the number.",
		}),
	]);
	const parallelMs = Date.now() - t0;
	results["worker-A"] = w1;
	results["worker-B"] = w2;
	console.log(`[workers] both done in ${parallelMs}ms (wall-clock for the pair)`);

	// --- Report --------------------------------------------------------------
	const nodes = [results.planner, w1, w2];
	console.log("\n================ SPIKE RESULTS ================");
	for (const n of nodes) {
		const tok = n.llmCalls.reduce((a, c) => a + c.total, 0);
		const cost = n.llmCalls.reduce((a, c) => a + c.cost, 0);
		const paths = n.toolCalls
			.map((tc) => tc.input?.path ?? tc.input?.pattern ?? tc.input?.file_path ?? JSON.stringify(tc.input))
			.slice(0, 6);
		console.log(`\n[${n.label}] session=${n.sessionId}`);
		console.log(`  llm_calls=${n.llmCalls.length}  tokens=${tok}  cost=$${cost.toFixed(6)}  latency=${n.latencyMs}ms`);
		console.log(`  tool_calls=${n.toolCalls.length}  tools=[${n.toolCalls.map((t) => t.tool).join(", ")}]`);
		console.log(`  captured read-set candidates: ${JSON.stringify(paths)}`);
		console.log(`  appendEntry: called=${n.appendEntryCalled} persisted(inMemory)=${n.appendEntryPersisted}${n.appendEntryErr ? " err=" + n.appendEntryErr : ""}`);
		console.log(`  final: ${JSON.stringify(n.finalText).slice(0, 160)}`);
	}

	// Cross-node isolation check: distinct session ids, distinct prompts honored.
	const ids = new Set(nodes.map((n) => n.sessionId));
	console.log("\n---- U-answers ----");
	console.log(`U1 per-node system prompt: workers stayed in-role => ${JSON.stringify([w1.finalText.slice(0,40), w2.finalText.slice(0,40)])}`);
	console.log(`U2 appendEntry on inMemory: planner called=${results.planner.appendEntryCalled} persisted=${results.planner.appendEntryPersisted} entry=${JSON.stringify(results.planner.appendEntrySample)}`);
	console.log(`U3 parallel isolation: ${ids.size} distinct session ids across 3 nodes (expect 3) = ${ids.size === 3}`);
	console.log(`U4 JSON output contract: planner JSON parseable = ${planParsed.ok}` + (planParsed.ok ? ` keys=${Object.keys(planParsed.value)}` : ` err=${planParsed.error}`));
	const sampleTool = nodes.flatMap((n) => n.toolCalls).find((t) => ["read", "ls", "grep", "find"].includes(t.tool));
	console.log(`U5a tool_call input shape (sample ${sampleTool?.tool}): ${JSON.stringify(sampleTool?.input)}`);
	const sampleResult = nodes.flatMap((n) => n.toolResults).find((t) => t.tool === "read") ?? nodes.flatMap((n) => n.toolResults)[0];
	console.log(`U5b tool_result shape (sample ${sampleResult?.tool}): isError=${sampleResult?.isError} contentTextChars=${sampleResult?.contentTextChars} details=${JSON.stringify(sampleResult?.details)}`);
	console.log(`U5b contentHead: ${JSON.stringify(sampleResult?.contentHead)}`);
	console.log("===============================================");
}

main().catch((e) => {
	console.error("SPIKE FAILED:", e);
	process.exit(1);
});
