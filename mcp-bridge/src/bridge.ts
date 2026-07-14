/**
 * McpBridge — the session-lived resident half of the MCP-over-bash bridge.
 *
 * On start() it connects EVERY configured MCP server once and keeps those
 * connections hot for the whole session. It then listens on a unix socket and
 * answers newline-delimited JSON requests from the short-lived `wea-mcp` CLI:
 * search / describe / call / list. On dispose() it closes the socket and every
 * server connection.
 *
 * Lifetime is deliberately tied to the owner (a pi session, via the extension in
 * extension.ts): connect once, reuse many times, disconnect at session end.
 * Nothing here spawns per-call — the whole point of "resident" is that the model
 * can `wea-mcp call` twenty times against warm connections.
 *
 * The MODEL never sees any of this: it only ever runs one bash command. The MCP
 * region (this class → real servers) is crossed by the CLI; results come back to
 * the shell region (stdout / --out file) where the model filters with rg/jq/>.
 */

import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BridgeRequest, BridgeResponse, ToolBrief } from "./protocol.ts";
import { McpExactCache } from "./reuse.ts";

const sha256 = (s: string): string => "sha256:" + createHash("sha256").update(s).digest("hex");

/** One server entry in mcp.servers.json. */
export type ServerConfig =
	| { name: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
	| { name: string; transport: "http"; url: string };

export interface McpServersFile {
	servers: ServerConfig[];
}

interface Connected {
	config: ServerConfig;
	client: Client;
	tools: ToolBrief[];
}

/** Hook: called for every completed `call` so an owner can record it (B1/B2). */
export type CallObserver = (record: {
	server: string;
	tool: string;
	args: unknown;
	isError: boolean;
	digest: string;
	readOnly: boolean;
	destructive: boolean;
	/** true when this call was served from the exact cache (no server hit). */
	cached: boolean;
}) => void;

export class McpBridge {
	private connected: Connected[] = [];
	private server?: Server;
	private observers: CallObserver[] = [];
	/** B2: exact reuse of read-only MCP results within the session (loosens D10). */
	private readonly cache = new McpExactCache();

	constructor(
		private readonly configs: ServerConfig[],
		private readonly socketPath: string,
		/** set false to disable exact reuse (e.g. for measuring its effect). */
		private readonly reuse = true,
	) {}

	get cacheSize(): number {
		return this.cache.size;
	}

	onCall(observer: CallObserver): void {
		this.observers.push(observer);
	}

	private emit(rec: Parameters<CallObserver>[0]): void {
		for (const obs of this.observers) obs(rec);
	}

	/** Connect all servers (hot), then open the socket. Idempotent-ish: call once. */
	async start(): Promise<void> {
		for (const config of this.configs) {
			const client = new Client({ name: "wea-mcp-bridge", version: "0.1.0" }, { capabilities: {} });
			const transport =
				config.transport === "stdio"
					? new StdioClientTransport({ command: config.command, args: config.args, env: config.env })
					: new StreamableHTTPClientTransport(new URL(config.url));
			await client.connect(transport);
			const listed = await client.listTools();
			const tools: ToolBrief[] = listed.tools.map((t) => ({
				id: `${config.name}.${t.name}`,
				server: config.name,
				name: t.name,
				description: t.description ?? "",
				readOnly: t.annotations?.readOnlyHint === true,
				destructive: t.annotations?.destructiveHint === true,
			}));
			this.connected.push({ config, client, tools });
		}
		await this.listen();
	}

	private allTools(): ToolBrief[] {
		return this.connected.flatMap((c) => c.tools);
	}

	private find(toolId: string): { conn: Connected; brief: ToolBrief } | undefined {
		for (const conn of this.connected) {
			const brief = conn.tools.find((t) => t.id === toolId || t.name === toolId);
			if (brief) return { conn, brief };
		}
		return undefined;
	}

	/** Answer one request against the warm connections. */
	async handle(req: BridgeRequest): Promise<BridgeResponse> {
		try {
			switch (req.cmd) {
				case "list": {
					const tools = req.server ? this.allTools().filter((t) => t.server === req.server) : this.allTools();
					return { ok: true, tools };
				}
				case "search": {
					// progressive disclosure: return name + one-line desc only.
					const q = req.query.toLowerCase();
					const terms = q.match(/[a-z0-9]+/g) ?? [];
					const scored = this.allTools()
						.map((t) => {
							const hay = `${t.id} ${t.description}`.toLowerCase();
							const score = terms.reduce((a, term) => a + (hay.includes(term) ? 1 : 0), 0);
							return { t, score };
						})
						.filter((x) => x.score > 0)
						.sort((a, b) => b.score - a.score)
						.map((x) => x.t);
					return { ok: true, tools: scored };
				}
				case "describe": {
					const hit = this.find(req.tool);
					if (!hit) return { ok: false, error: `unknown tool ${req.tool}` };
					const listed = await hit.conn.client.listTools();
					const full = listed.tools.find((t) => t.name === hit.brief.name);
					return { ok: true, tool: { ...hit.brief, inputSchema: full?.inputSchema ?? {} } };
				}
				case "call": {
					const hit = this.find(req.tool);
					if (!hit) return { ok: false, error: `unknown tool ${req.tool}` };
					const { server, id: toolId, name, readOnly, destructive } = hit.brief;

					// B2: exact reuse — a read-only repeat returns the stored result
					// without touching the server. Effectful/unknown calls always run.
					if (this.reuse && readOnly && !destructive) {
						const cached = this.cache.lookup(server, toolId, req.args);
						if (cached.hit) {
							this.emit({ server, tool: toolId, args: req.args, isError: false, digest: cached.certificate.result_digest, readOnly, destructive, cached: true });
							return {
								ok: true,
								result: { isError: false, text: cached.text, digest: cached.certificate.result_digest, readOnly, destructive, cached: true },
							};
						}
					}

					const res = await hit.conn.client.callTool({ name, arguments: (req.args ?? {}) as Record<string, unknown> });
					const text = (Array.isArray(res.content) ? res.content : [])
						.filter((c: { type: string }) => c.type === "text")
						.map((c: { text: string }) => c.text)
						.join("\n");
					const digest = sha256(text);
					const isError = res.isError === true;
					const rec = { server, tool: toolId, args: req.args, isError, digest, readOnly, destructive };
					this.cache.store(rec, text); // no-op unless read-only & non-destructive
					this.emit({ ...rec, cached: false });
					return { ok: true, result: { isError, text, digest, readOnly, destructive, cached: false } };
				}
			}
		} catch (err) {
			return { ok: false, error: String((err as Error)?.message ?? err) };
		}
	}

	private async listen(): Promise<void> {
		if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
		this.server = createServer((sock: Socket) => {
			let buf = "";
			sock.on("data", async (chunk) => {
				buf += chunk.toString("utf8");
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (!line.trim()) continue;
					let resp: BridgeResponse;
					try {
						resp = await this.handle(JSON.parse(line) as BridgeRequest);
					} catch (err) {
						resp = { ok: false, error: `bad request: ${String((err as Error)?.message ?? err)}` };
					}
					sock.write(JSON.stringify(resp) + "\n");
				}
			});
		});
		await new Promise<void>((res, rej) => {
			this.server!.once("error", rej);
			this.server!.listen(this.socketPath, res);
		});
	}

	get path(): string {
		return this.socketPath;
	}

	/** Close socket + every server connection. Tie this to session dispose. */
	async dispose(): Promise<void> {
		if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
		if (existsSync(this.socketPath)) {
			try {
				unlinkSync(this.socketPath);
			} catch {
				/* already gone */
			}
		}
		for (const c of this.connected) {
			try {
				await c.client.close();
			} catch {
				/* best effort */
			}
		}
		this.connected = [];
	}
}
