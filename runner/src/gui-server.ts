/**
 * wea gui — a local web UI for the runner.
 *
 * Serves the static frontend (runner/gui/) and a small JSON+SSE API over the
 * same orchestrator the CLI uses:
 *
 *   GET  /api/health              → control/worker execution hints
 *   GET  /api/templates           → catalog incl. graph structure (for preview)
 *   POST /api/run                 → { task, template, repo } → { runId }
 *   GET  /api/run/:id/events      → SSE; replays buffered events, then live
 *   GET  /api/run/:id             → snapshot { events } (refresh safety)
 *
 * Binds 127.0.0.1 only. Runs always use real pi workers in an isolated Git
 * worktree. WEA_* enables control-plane plan/adapt/cold-start; without it the
 * runner uses offline retrieval while workers still use the pi default model.
 *
 * Run:  npm run gui   →  http://127.0.0.1:7788
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { executeRun, resolveTemplateRef, type RunEvent } from "./orchestrator.ts";
import { loadTemplate } from "./library.ts";
import { loadTemplateCatalog } from "./retrieval.ts";
import { loadWeaControlConfig } from "./wea-control.ts";

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

/** WEA control-plane config (plan/adapt/cold-start). Workers use pi default. */
function controlEnv() {
	return loadWeaControlConfig();
}

/** Workers need a default pi model; the factory validates it at run start. */
function executionHint(): { controlAvailable: boolean; note: string } {
	const c = controlEnv();
	return {
		controlAvailable: c !== null,
		note: c
			? `control=${c.modelId}; workers=pi default model`
			: "control offline (retrieval only); workers=pi default model",
	};
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
			const hint = executionHint();
			return json(res, 200, {
				workerMode: "pi-default",
				controlAvailable: hint.controlAvailable,
				note: hint.note,
				port: PORT,
			});
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
			};
			if ("mode" in body) {
				return json(res, 400, { error: "mode selection has been removed; runs always use real pi workers" });
			}
			const task = (body.task ?? "").trim();
			if (!task) return json(res, 400, { error: "task is required" });
			const control = controlEnv();
			const templateRef = body.template?.trim() || "auto";
			const repo = body.repo?.trim() || process.cwd();

			// Early validation for explicit templates only (auto plans at run start).
			if (templateRef !== "auto") {
				try {
					const resolved = resolveTemplateRef({ task, templateRef });
					loadTemplate(resolved.ref);
				} catch (err) {
					return json(res, 400, { error: String((err as Error).message) });
				}
			}

			const state: RunState = { events: [], listeners: new Set(), done: false };
			let runId = "";
			const started = new Promise<string>((resolve) => {
				void executeRun({
					task,
					templateRef,
					repo,
					out: join(HERE, "..", "runs"),
					control,
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
	const hint = executionHint();
	console.log(`wea gui →  http://${HOST}:${PORT}`);
	console.log(`  ${hint.note}`);
});
