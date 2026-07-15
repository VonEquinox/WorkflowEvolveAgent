/**
 * pi InlineExtension that owns a resident McpBridge for the life of a session.
 *
 * This is the piece that makes the bridge "session-lived", as required: pi loads
 * the extension when a session starts and disposes it when the session ends, so
 * the MCP server connections come up once and stay hot for every `wea-mcp call`
 * the model makes, then tear down at session end.
 *
 * Wiring for the model's bash:
 *   - pi's bash tool inherits process.env (utils/shell.ts getShellEnv), so we set
 *     process.env[WEA_MCP_SOCKET] to this session's socket path. The thin CLI
 *     reads it. (The extension also returns the socket path so the runner can put
 *     the CLI on PATH / expose it however it launches sessions.)
 *   - on before_agent_start we prepend a short usage note to the system prompt so
 *     the model knows the command exists and how to keep results out of context.
 *
 * Usage from the runner (Phase 0 InlineExtension mechanism):
 *   const { factory, ready, dispose } = makeMcpBridgeExtension({ sessionId, servers });
 *   // add `factory` to DefaultResourceLoader extensionFactories; await ready
 *   // before prompting; call dispose() after session.dispose().
 */

import { McpBridge, type ServerConfig } from "./bridge.ts";
import type { CallObserver } from "./bridge.ts";
import { socketPathFor, SOCKET_ENV } from "./protocol.ts";

export interface McpBridgeExtensionOptions {
	sessionId: string;
	servers: ServerConfig[];
	/** observe every MCP call (recorder integration, B1/B2). */
	onCall?: CallObserver;
	socketDir?: string;
}

const USAGE_NOTE = (socketReady: boolean): string =>
	[
		"## MCP tools via bash (wea-mcp)",
		socketReady
			? "You have external MCP tools, reachable through ONE bash command: `wea-mcp`."
			: "(MCP bridge configured but not yet ready.)",
		"Discover then call — do not ask for tool schemas up front:",
		"  wea-mcp search \"<keywords>\"        # find tools (names + one-line descriptions)",
		"  wea-mcp describe <server.tool>       # one tool's full input schema, only when needed",
		"  wea-mcp call <server.tool> --json '{...}'            # small results go to stdout",
		"  wea-mcp call <server.tool> --json '{...}' --out FILE # big results go to FILE, not your context",
		"Prefer --out for anything large, then filter in the shell before reading:",
		"  wea-mcp call ... --out /tmp/r.json && rg PATTERN /tmp/r.json   # or | jq, > file, etc.",
		"Tools marked [ro] are read-only (safe to repeat); [!] are destructive (use with care).",
	].join("\n");

export interface McpBridgeHandle {
	/** the pi InlineExtension factory to register on the resource loader. */
	factory: (pi: unknown) => void;
	/** resolves after startup succeeds or fails; inspect status() afterwards. */
	ready: Promise<void>;
	/** socket path this session's CLI must talk to (also set in process.env). */
	socketPath: string;
	/** Current startup state, suitable for diagnostics and slash commands. */
	status: () => { state: "starting" | "ready" | "failed"; error?: string };
	/** tear down socket + all server connections; call after session dispose. */
	dispose: () => Promise<void>;
}

export function makeMcpBridgeExtension(opts: McpBridgeExtensionOptions): McpBridgeHandle {
	const socketPath = socketPathFor(opts.sessionId, opts.socketDir);
	const bridge = new McpBridge(opts.servers, socketPath);
	if (opts.onCall) bridge.onCall(opts.onCall);

	// Expose the socket to any bash the session spawns (pi inherits process.env).
	process.env[SOCKET_ENV] = socketPath;

	let state: "starting" | "ready" | "failed" = "starting";
	let failure: string | undefined;
	const ready = bridge
		.start()
		.then(() => {
			state = "ready";
		})
		.catch((err) => {
			// Fail loud but don't crash the session: bash just won't find a bridge.
			state = "failed";
			failure = String((err as Error)?.message ?? err);
			console.error(`[wea-mcp] bridge failed to start: ${failure}`);
		});

	const factory = (pi: any): void => {
		pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
			const note = state === "failed"
				? `## MCP bridge unavailable\nWEA MCP bridge failed to start: ${failure ?? "unknown error"}. Fix the configuration, then run /reload.`
				: USAGE_NOTE(state === "ready");
			return { systemPrompt: `${event.systemPrompt}\n\n${note}` };
		});
		// If pi drives session lifecycle, tie teardown to it too (belt & braces;
		// the runner also calls dispose() explicitly).
		pi.on("session_shutdown", async () => {
			await dispose();
		});
	};

	const dispose = async (): Promise<void> => {
		await bridge.dispose();
		if (process.env[SOCKET_ENV] === socketPath) delete process.env[SOCKET_ENV];
	};

	return {
		factory,
		ready,
		socketPath,
		status: () => ({ state, ...(failure ? { error: failure } : {}) }),
		dispose,
	};
}
