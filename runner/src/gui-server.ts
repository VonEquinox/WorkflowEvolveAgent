/**
 * wea gui — a local web UI for the runner.
 *
 * Serves the static frontend (runner/gui/) and a small JSON+SSE API over the
 * same orchestrator the CLI uses:
 *
 *   GET  /api/health              → { liveAvailable } (env configured?)
 *   GET  /api/templates           → catalog incl. graph structure (for preview)
 *   POST /api/run                 → { task, template, repo, mode } → { runId }
 *   GET  /api/run/:id/events      → SSE; replays buffered events, then live
 *   GET  /api/run/:id             → snapshot { events } (refresh safety)
 *
 * Binds 127.0.0.1 only. Sim mode works with no endpoint configured — the GUI is
 * fully demonstrable offline; live mode appears automatically when WEA_* env is
 * set.
 *
 * Run:  npm run gui   →  http://127.0.0.1:7788
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { executeRun, resolveTemplateRef, type RunEvent, type RunMode } from "./orchestrator.ts";
import { loadTemplate } from "./library.ts";
import { loadTemplateCatalog } from "./retrieval.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI_DIR = join(HERE, "..", "gui");
const PORT = Number(process.env.WEA_GUI_PORT ?? 7788);
const HOST = "127.0.0.1";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
};

function env(): { baseUrl: string; apiKey: string; modelId: string } | null {
	const { WEA_BASE_URL, WEA_API_KEY, WEA_MODEL } = process.env;
	return WEA_BASE_URL && WEA_API_KEY && WEA_MODEL
		? { baseUrl: WEA_BASE_URL, apiKey: WEA_API_KEY, modelId: WEA_MODEL }
		: null;
}

// ---- run registry -------------------------------------------------------------

interface RunState {
	events: RunEvent[];
	listeners: Set<ServerResponse>;
	done: boolean;
}
const runs = new Map<string, RunState>();

function broadcast(state: RunState, event: RunEvent): void {
	state.events.push(event);
	const line = `data: ${JSON.stringify(event)}\n\n`;
	for (const res of state.listeners) res.write(line);
	if (event.type === "run_done") {
		state.done = true;
		for (const res of state.listeners) res.end();
		state.listeners.clear();
	}
}

// ---- helpers --------------------------------------------------------------------

function json(res: ServerResponse, code: number, body: unknown): void {
	const s = JSON.stringify(body);
	res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
	res.end(s);
}

async function readBody(req: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of req) body += chunk;
	return body;
}

function serveStatic(res: ServerResponse, urlPath: string): void {
	const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
	const file = normalize(join(GUI_DIR, rel));
	if (!file.startsWith(GUI_DIR) || !existsSync(file)) {
		res.writeHead(404).end("not found");
		return;
	}
	const data = readFileSync(file);
	res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
	res.end(data);
}

// ---- server ---------------------------------------------------------------------

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://${HOST}`);
	const path = url.pathname;
	try {
		if (req.method === "GET" && path === "/api/health") {
			return json(res, 200, { liveAvailable: env() !== null, port: PORT });
		}

		if (req.method === "GET" && path === "/api/templates") {
			const catalog = loadTemplateCatalog().map((t) => ({
				id: t.id,
				version: t.version,
				summary: t.summary,
				graph: t.graph,
			}));
			return json(res, 200, { templates: catalog });
		}

		if (req.method === "POST" && path === "/api/run") {
			const body = JSON.parse((await readBody(req)) || "{}") as {
				task?: string;
				template?: string;
				repo?: string;
				mode?: RunMode;
			};
			const task = (body.task ?? "").trim();
			if (!task) return json(res, 400, { error: "task is required" });
			const mode: RunMode = body.mode === "live" ? "live" : "sim";
			const e = env();
			if (mode === "live" && !e) return json(res, 400, { error: "live mode needs WEA_BASE_URL / WEA_API_KEY / WEA_MODEL" });
			const templateRef = body.template?.trim() || "auto";
			const repo = body.repo?.trim() || process.cwd();

			// Resolve + load early so a bad template/cards 400s with a real message
			// before a run id exists.
			try {
				const resolved = resolveTemplateRef({ task, templateRef });
				loadTemplate(resolved.ref);
			} catch (err) {
				return json(res, 400, { error: String((err as Error).message) });
			}

			const state: RunState = { events: [], listeners: new Set(), done: false };
			let runId = "";
			const started = new Promise<string>((resolve) => {
				void executeRun({
					task,
					templateRef,
					repo,
					out: mode === "live" ? join(HERE, "..", "runs") : undefined,
					mode,
					env: e ?? undefined,
					onEvent: (event) => {
						if (event.type === "run_started") {
							runId = event.runId;
							runs.set(runId, state);
							resolve(runId);
						}
						broadcast(state, event);
					},
				}).catch((err) => {
					broadcast(state, { type: "log", message: `RUN CRASHED: ${String((err as Error).message)}` });
					broadcast(state, { type: "run_done", status: "failure", tokens: 0, costMicrounits: 0, files: [] });
					if (!runId) resolve("");
				});
			});
			const id = await started;
			if (!id) return json(res, 500, { error: "run failed to start (see server log)" });
			return json(res, 200, { runId: id });
		}

		const evMatch = path.match(/^\/api\/run\/([a-f0-9-]+)\/events$/);
		if (req.method === "GET" && evMatch) {
			const state = runs.get(evMatch[1]!);
			if (!state) return json(res, 404, { error: "unknown run" });
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			for (const event of state.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
			if (state.done) return void res.end();
			state.listeners.add(res);
			req.on("close", () => state.listeners.delete(res));
			return;
		}

		const snapMatch = path.match(/^\/api\/run\/([a-f0-9-]+)$/);
		if (req.method === "GET" && snapMatch) {
			const state = runs.get(snapMatch[1]!);
			if (!state) return json(res, 404, { error: "unknown run" });
			return json(res, 200, { events: state.events, done: state.done });
		}

		if (req.method === "GET") return serveStatic(res, path);
		res.writeHead(405).end();
	} catch (err) {
		json(res, 500, { error: String((err as Error).message) });
	}
});

server.listen(PORT, HOST, () => {
	console.log(`wea gui →  http://${HOST}:${PORT}   (live mode: ${env() ? "available" : "off — set WEA_* env"})`);
});
