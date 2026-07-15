/**
 * Installable Pi package entry point for WEA's MCP-over-bash bridge.
 *
 * `pi install git:github.com/VonEquinox/WorkflowEvolveAgent` loads this file.
 * It starts one resident bridge per Pi session, puts the thin `wea-mcp` command
 * on bash's PATH, and injects progressive-disclosure usage guidance.
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverMcpConfig } from "../mcp-bridge/src/config.ts";
import { makeMcpBridgeExtension } from "../mcp-bridge/src/extension.ts";
import type { ServerConfig } from "../mcp-bridge/src/bridge.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_BIN = join(PACKAGE_ROOT, "bin");
const LEGACY_CONFIG = join(PACKAGE_ROOT, "mcp-bridge", "mcp.servers.json");

interface PiApi {
	on(event: string, handler: (...args: any[]) => unknown): void;
	registerCommand?(name: string, options: { description: string; handler: (args: string, ctx: any) => unknown }): void;
}

function putCliOnPath(): void {
	const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	if (!entries.includes(PACKAGE_BIN)) process.env.PATH = [PACKAGE_BIN, ...entries].join(delimiter);
}

function defaultFilesystemServer(cwd: string): ServerConfig {
	const require = createRequire(import.meta.url);
	const entrypoint = require.resolve("@modelcontextprotocol/server-filesystem/dist/index.js");
	return {
		name: "workspace",
		transport: "stdio",
		command: process.execPath,
		args: [entrypoint, cwd],
	};
}

export default async function weaMcpPiExtension(pi: PiApi): Promise<void> {
	putCliOnPath();
	const cwd = process.cwd();
	const homeDir = process.env.HOME ?? cwd;
	let loaded;
	try {
		loaded = discoverMcpConfig({
			cwd,
			homeDir,
			extraPaths: [LEGACY_CONFIG],
			fallbackServers: () => [defaultFilesystemServer(cwd)],
		});
	} catch (error) {
		const message = String((error as Error)?.message ?? error);
		console.error(`[wea-mcp] configuration error: ${message}`);
		pi.on("before_agent_start", async (event: { systemPrompt: string }) => ({
			systemPrompt: `${event.systemPrompt}\n\n## MCP bridge unavailable\nWEA MCP configuration error: ${message}\nFix the config, then run /reload.`,
		}));
		pi.registerCommand?.("wea-mcp", {
			description: "Show WEA MCP bridge status",
			handler: async (_args, ctx) => ctx.ui.notify(`WEA MCP configuration error: ${message}`, "error"),
		});
		return;
	}

	const handle = makeMcpBridgeExtension({
		sessionId: `pi-${process.pid}-${randomUUID()}`,
		servers: loaded.servers,
	});
	handle.factory(pi);
	await handle.ready;

	pi.registerCommand?.("wea-mcp", {
		description: "Show WEA MCP bridge status and configuration",
		handler: async (_args, ctx) => {
			const status = handle.status();
			const serverNames = loaded.servers.map((server) => server.name).join(", ") || "(none)";
			const fallback = loaded.fallback ? " (automatic cwd-scoped fallback)" : "";
			const detail = status.error ? `failed: ${status.error}` : status.state;
			ctx.ui.notify(`WEA MCP ${detail}\nservers: ${serverNames}\nconfig: ${loaded.source}${fallback}`, status.error ? "error" : "info");
		},
	});
}
