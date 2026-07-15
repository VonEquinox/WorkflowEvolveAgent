#!/usr/bin/env -S npx tsx

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import weaMcpPiExtension from "../../extensions/wea-mcp.ts";
import { discoverMcpConfig, loadMcpServersFile } from "./config.ts";

const execFileAsync = promisify(execFile);

let failures = 0;
function check(label: string, ok: unknown): void {
	if (ok) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}`);
	}
}

const sandbox = mkdtempSync(join(tmpdir(), "wea-pi-extension-"));
const workspace = join(sandbox, "workspace");
const home = join(sandbox, "home");
mkdirSync(workspace, { recursive: true });
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
writeFileSync(join(workspace, "hello.txt"), "PI_MCP_READY\n");

console.log("Pi MCP config discovery");
const configPath = join(home, ".pi", "agent", "mcp.servers.json");
writeFileSync(
	configPath,
	JSON.stringify({ servers: [{ name: "remote", transport: "http", url: "$TEST_MCP_URL" }] }),
);
const loaded = discoverMcpConfig({
	cwd: workspace,
	homeDir: home,
	env: { TEST_MCP_URL: "https://example.invalid/mcp" },
	fallbackServers: () => [],
});
check("discovers user config", loaded.source === configPath && !loaded.fallback);
check("expands environment variables", loaded.servers[0]?.transport === "http" && loaded.servers[0].url === "https://example.invalid/mcp");

writeFileSync(configPath, JSON.stringify({ servers: [{ name: "bad name", transport: "stdio", command: "node" }] }));
let rejectedInvalid = false;
try {
	loadMcpServersFile(configPath);
} catch {
	rejectedInvalid = true;
}
check("rejects invalid server names", rejectedInvalid);
rmSync(configPath);

console.log("\nInstallable Pi extension — default cwd-scoped filesystem MCP");
type Handler = (...args: any[]) => unknown;
const handlers = new Map<string, Handler[]>();
let commandHandler: Handler | undefined;
const notifications: string[] = [];
const pi = {
	on(event: string, handler: Handler) {
		const entries = handlers.get(event) ?? [];
		entries.push(handler);
		handlers.set(event, entries);
	},
	registerCommand(name: string, options: { handler: Handler }) {
		if (name === "wea-mcp") commandHandler = options.handler;
	},
};

const oldCwd = process.cwd();
const oldHome = process.env.HOME;
const oldPath = process.env.PATH;
const oldConfig = process.env.WEA_MCP_CONFIG;
try {
	process.chdir(workspace);
	process.env.HOME = home;
	delete process.env.WEA_MCP_CONFIG;
	await weaMcpPiExtension(pi);

	check("registers /wea-mcp", typeof commandHandler === "function");
	check("registers lifecycle handlers", (handlers.get("before_agent_start")?.length ?? 0) === 1 && (handlers.get("session_shutdown")?.length ?? 0) === 1);

	const before = handlers.get("before_agent_start")![0]!;
	const injected = (await before({ systemPrompt: "BASE" })) as { systemPrompt: string };
	check("injects wea-mcp usage into the agent prompt", injected.systemPrompt.includes("wea-mcp search") && injected.systemPrompt.includes("wea-mcp call"));

	const cli = resolve(oldCwd, "bin", "wea-mcp");
	const listed = await execFileAsync(cli, ["list"], { encoding: "utf8", env: process.env });
	check("thin CLI reaches the resident bridge", listed.stdout.includes("workspace."));

	const out = join(sandbox, "mcp-result.txt");
	const receipt = await execFileAsync(
		cli,
		["call", "workspace.read_text_file", "--json", JSON.stringify({ path: join(process.cwd(), "hello.txt") }), "--out", out],
		{ encoding: "utf8", env: process.env },
	);
	check("MCP call can read only the current workspace", receipt.stdout.includes("wrote") && readFileSync(out, "utf8").includes("PI_MCP_READY"));

	await commandHandler?.("", { ui: { notify: (message: string) => notifications.push(message) } });
	check("/wea-mcp reports ready status", notifications.some((message) => message.includes("WEA MCP ready") && message.includes("workspace")));

	for (const shutdown of handlers.get("session_shutdown") ?? []) await shutdown({ reason: "quit" }, {});
	let stopped = false;
	try {
		await execFileAsync(cli, ["list"], { encoding: "utf8", env: process.env });
	} catch {
		stopped = true;
	}
	check("session shutdown tears down the bridge", stopped);
} finally {
	process.chdir(oldCwd);
	if (oldHome === undefined) delete process.env.HOME;
	else process.env.HOME = oldHome;
	if (oldPath === undefined) delete process.env.PATH;
	else process.env.PATH = oldPath;
	if (oldConfig === undefined) delete process.env.WEA_MCP_CONFIG;
	else process.env.WEA_MCP_CONFIG = oldConfig;
	rmSync(sandbox, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nPI EXTENSION SELF-TEST FAILED: ${failures} check(s)`);
	process.exit(1);
}
console.log("\nPI EXTENSION SELF-TEST PASSED");
