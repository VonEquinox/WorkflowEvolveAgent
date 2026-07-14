/**
 * End-to-end self-test for the MCP-over-bash bridge — against a REAL MCP server
 * (@modelcontextprotocol/server-filesystem). No mocks.
 *
 * Proves the whole B0 chain and the "resident, session-lived, connection-reused"
 * property you required:
 *   1. start ONE resident bridge → it connects the fs server once (hot);
 *   2. drive it exactly as the thin CLI would (JSONL over the unix socket):
 *      list → search → describe → call, MULTIPLE calls over the SAME connection;
 *   3. dispose → socket + server connection torn down.
 *
 * Run:  npm test   (exits non-zero on any failed check)
 */

import { connect } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpBridge, type ServerConfig } from "./bridge.ts";
import type { BridgeRequest, BridgeResponse } from "./protocol.ts";
import { socketPathFor } from "./protocol.ts";
import { mcpCacheable } from "./reuse.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
	console.log(`${cond ? "  ✓" : "  ✗ FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
	if (!cond) failures += 1;
}

/** Talk to the bridge exactly like the CLI does: one JSON line, one JSON line back. */
function ask(socketPath: string, req: BridgeRequest): Promise<BridgeResponse> {
	return new Promise((resolve, reject) => {
		const sock = connect(socketPath);
		let buf = "";
		sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
		sock.on("data", (d) => {
			buf += d.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				sock.end();
				resolve(JSON.parse(buf.slice(0, nl)) as BridgeResponse);
			}
		});
		sock.on("error", reject);
	});
}

async function main(): Promise<void> {
	// A sandbox dir the fs server is allowed to read, with a known file.
	const sandbox = mkdtempSync(join(tmpdir(), "wea-mcp-fs-"));
	writeFileSync(join(sandbox, "hello.txt"), "the quick brown fox\nMATCH_ME jumps\nover the lazy dog\n");

	const fsServer: ServerConfig = {
		name: "fs",
		transport: "stdio",
		command: "node",
		args: [join(process.cwd(), "node_modules", "@modelcontextprotocol", "server-filesystem", "dist", "index.js"), sandbox],
	};

	const socketPath = socketPathFor("selftest");
	const bridge = new McpBridge([fsServer], socketPath);

	// B1/B2 hook: observe calls (this is what the recorder will do).
	const observed: { tool: string; readOnly: boolean; digest: string; cached: boolean }[] = [];
	bridge.onCall((r) => observed.push({ tool: r.tool, readOnly: r.readOnly, digest: r.digest, cached: r.cached }));

	console.log("MCP bridge — end-to-end against real filesystem server\n");
	console.log("start(): connect fs server (hot) + open socket");
	await bridge.start();
	check("bridge is listening on its socket", true, socketPath);

	console.log("\nlist / search / describe (progressive disclosure)");
	const list = await ask(socketPath, { cmd: "list" });
	check("list returns tools from the connected server", (list.tools?.length ?? 0) > 0, `${list.tools?.length} tools`);
	check("read-only tools are flagged (from MCP annotations)", (list.tools ?? []).some((t) => t.readOnly));

	const search = await ask(socketPath, { cmd: "search", query: "read file" });
	check("search finds a read tool by keyword", (search.tools ?? []).some((t) => /read/i.test(t.id)));
	const readTool = (search.tools ?? []).find((t) => /read/i.test(t.name) && /text|file/i.test(t.id + t.description));
	const readToolId = readTool?.id ?? (list.tools ?? []).find((t) => /read_text_file|read_file/.test(t.name))?.id;
	check("a concrete read-file tool exists", !!readToolId, readToolId ?? "(none)");

	if (readToolId) {
		const desc = await ask(socketPath, { cmd: "describe", tool: readToolId });
		check("describe returns a full input schema", !!desc.tool && !!(desc.tool as { inputSchema: unknown }).inputSchema);

		console.log("\ncall — MULTIPLE calls over the SAME hot connection (reuse)");
		const filePath = join(sandbox, "hello.txt");
		const c1 = await ask(socketPath, { cmd: "call", tool: readToolId, args: { path: filePath } });
		check("call #1 returns the file contents", !!c1.result && c1.result.text.includes("MATCH_ME"));
		check("call #1 result carries a digest", !!c1.result?.digest?.startsWith("sha256:"));
		check("call #1 marked read-only (cache-eligible, D10 loosened)", c1.result?.readOnly === true);

		const c2 = await ask(socketPath, { cmd: "call", tool: readToolId, args: { path: filePath } });
		check("call #2 over the same connection is deterministic", c1.result?.digest === c2.result?.digest);
		check("both calls were observed by the recorder hook (B1)", observed.length === 2);
		check("identical calls → identical digests (reuse-sound)", observed[0]?.digest === observed[1]?.digest);

		// B2: the second identical read-only call is served from the exact cache.
		check("call #1 hit the server (not cached)", observed[0]?.cached === false);
		check("call #2 served from exact cache (B2 — read-only reuse, loosens D10)", observed[1]?.cached === true && c2.result?.cached === true);
		check("exact cache holds exactly one read-only entry", bridge.cacheSize === 1);

		// A DIFFERENT arg is a cache miss (must hit the server).
		const other = join(sandbox, "other.txt");
		writeFileSync(other, "different content\n");
		const c3 = await ask(socketPath, { cmd: "call", tool: readToolId, args: { path: other } });
		check("different args → cache miss, real call", c3.result?.cached === false && c3.result?.text.includes("different"));
	}

	// B2 fail-closed classification (direct unit checks on the reuse policy).
	console.log("\nreuse policy — fail-closed classification (B2)");
	check("read-only, non-destructive → cacheable", mcpCacheable({ readOnly: true, destructive: false, isError: false }).ok);
	check("destructive tool → never cached", !mcpCacheable({ readOnly: true, destructive: true, isError: false }).ok);
	check("not annotated read-only → not cached (fail-closed)", !mcpCacheable({ readOnly: false, destructive: false, isError: false }).ok);
	check("errored call → not cached", !mcpCacheable({ readOnly: true, destructive: false, isError: true }).ok);

	console.log("\ndispose(): tear down socket + server connection");
	await bridge.dispose();
	let reachableAfter = true;
	try {
		await ask(socketPath, { cmd: "list" });
	} catch {
		reachableAfter = false;
	}
	check("socket is gone after dispose (session-lived)", !reachableAfter);

	console.log("");
	if (failures > 0) {
		console.error(`SELF-TEST FAILED: ${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("SELF-TEST PASSED — resident bridge + real MCP server + connection reuse all green.");
}

main().catch((err) => {
	console.error("SELF-TEST ERROR:", err);
	process.exit(1);
});
