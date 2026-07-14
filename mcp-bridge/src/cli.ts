#!/usr/bin/env -S npx tsx
/**
 * wea-mcp — the thin, short-lived CLI half of the bridge.
 *
 * It does NOT connect to any MCP server. It connects to the session's resident
 * bridge over a unix socket (path from $WEA_MCP_SOCKET), sends one JSON request,
 * prints the response, and exits. To the model this is just one bash command.
 *
 * Commands (progressive disclosure + result-stays-in-shell):
 *   wea-mcp list [--server NAME]           list tools (name + one-line desc)
 *   wea-mcp search "query"                 find tools by keyword (name+desc only)
 *   wea-mcp describe server.tool           one tool's full input schema
 *   wea-mcp call server.tool --json '{..}' [--out FILE]
 *                                          call a tool; result to stdout, or
 *                                          --out FILE for big results (kept OUT
 *                                          of the model's context — the model
 *                                          then rg/jq/cats the file itself)
 *
 * Exit code is 0 on ok, 1 on error, so bash `&&` chains behave.
 */

import { connect } from "node:net";
import { writeFileSync } from "node:fs";
import type { BridgeRequest, BridgeResponse } from "./protocol.ts";
import { SOCKET_ENV } from "./protocol.ts";

function usage(): never {
	process.stderr.write(
		[
			"usage:",
			"  wea-mcp list [--server NAME]",
			'  wea-mcp search "query"',
			"  wea-mcp describe server.tool",
			`  wea-mcp call server.tool --json '{...}' [--out FILE]`,
			"",
			`(needs $${SOCKET_ENV}; set by the resident bridge)`,
		].join("\n") + "\n",
	);
	process.exit(2);
}

function parse(argv: string[]): BridgeRequest {
	const [cmd, ...rest] = argv;
	const flag = (name: string): string | undefined => {
		const i = rest.indexOf(name);
		return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined;
	};
	const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1]!.startsWith("--")));
	switch (cmd) {
		case "list":
			return { cmd: "list", server: flag("--server") };
		case "search": {
			const query = positional[0];
			if (!query) usage();
			return { cmd: "search", query };
		}
		case "describe": {
			const tool = positional[0];
			if (!tool) usage();
			return { cmd: "describe", tool };
		}
		case "call": {
			const tool = positional[0];
			if (!tool) usage();
			const json = flag("--json") ?? "{}";
			let args: unknown;
			try {
				args = JSON.parse(json);
			} catch {
				process.stderr.write(`--json is not valid JSON: ${json}\n`);
				process.exit(2);
			}
			return { cmd: "call", tool, args };
		}
		default:
			usage();
	}
}

function request(socketPath: string, req: BridgeRequest): Promise<BridgeResponse> {
	return new Promise((resolve, reject) => {
		const sock = connect(socketPath);
		let buf = "";
		let done = false;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			sock.removeAllListeners();
			sock.destroy(); // free the handle so the short-lived CLI can exit promptly
			fn();
		};
		sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
		sock.on("data", (d) => {
			buf += d.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				const line = buf.slice(0, nl);
				finish(() => {
					try {
						resolve(JSON.parse(line) as BridgeResponse);
					} catch (err) {
						reject(err);
					}
				});
			}
		});
		sock.on("error", (err) => finish(() => reject(err)));
	});
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.length === 0) usage();
	const socketPath = process.env[SOCKET_ENV];
	if (!socketPath) {
		process.stderr.write(`no resident bridge: $${SOCKET_ENV} is unset\n`);
		process.exit(1);
	}
	const req = parse(argv);
	const outFile = (() => {
		const i = argv.indexOf("--out");
		return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
	})();

	let resp: BridgeResponse;
	try {
		resp = await request(socketPath, req);
	} catch (err) {
		process.stderr.write(`bridge unreachable: ${String((err as Error)?.message ?? err)}\n`);
		process.exit(1);
	}

	if (!resp.ok) {
		process.stderr.write(`error: ${resp.error}\n`);
		process.exit(1);
	}

	// Render per command, keeping big results OUT of stdout when --out is given.
	if (resp.tools) {
		for (const t of resp.tools) {
			process.stdout.write(`${t.id}${t.readOnly ? " [ro]" : ""}${t.destructive ? " [!]" : ""}  ${t.description}\n`);
		}
	} else if (resp.tool) {
		process.stdout.write(JSON.stringify(resp.tool, null, 2) + "\n");
	} else if (resp.result) {
		const r = resp.result;
		if (outFile) {
			writeFileSync(outFile, r.text);
			// Only a tiny receipt goes to the model's context; the bytes are on disk.
			process.stdout.write(
				`wrote ${r.text.length} chars to ${outFile} (digest ${r.digest.slice(0, 19)}…, ${r.readOnly ? "read-only" : "effectful"})\n`,
			);
		} else {
			process.stdout.write(r.text + (r.text.endsWith("\n") ? "" : "\n"));
		}
		if (r.isError) process.exit(1);
	}
	process.exit(0); // short-lived CLI: exit deterministically once rendered
}

main().catch((err) => {
	process.stderr.write(`wea-mcp: ${String((err as Error)?.message ?? err)}\n`);
	process.exit(1);
});
