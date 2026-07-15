/**
 * Discovery and validation for the MCP server file used by the interactive Pi
 * extension. Configuration is intentionally separate from Pi's settings so MCP
 * credentials can stay in environment variables and a gitignored JSON file.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { McpServersFile, ServerConfig } from "./bridge.ts";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ENV_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

export interface LoadedMcpConfig {
	servers: ServerConfig[];
	source: string;
	fallback: boolean;
}

export interface DiscoverMcpConfigOptions {
	cwd: string;
	homeDir: string;
	env?: NodeJS.ProcessEnv;
	/** Extra compatibility locations checked after project/user config. */
	extraPaths?: string[];
	/** Used only when no config file exists. */
	fallbackServers: () => ServerConfig[];
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
	return value;
}

function expandEnv(input: string, env: NodeJS.ProcessEnv, source: string): string {
	return input.replace(ENV_RE, (_match, braced: string | undefined, bare: string | undefined) => {
		const name = braced ?? bare!;
		const value = env[name];
		if (value === undefined) throw new Error(`${source}: environment variable ${name} is not set`);
		return value;
	});
}

function validateServer(raw: unknown, index: number, env: NodeJS.ProcessEnv, source: string): ServerConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source}: servers[${index}] must be an object`);
	const item = raw as Record<string, unknown>;
	const name = nonEmptyString(item.name, `${source}: servers[${index}].name`);
	if (!NAME_RE.test(name)) throw new Error(`${source}: server name ${JSON.stringify(name)} contains unsupported characters`);
	const transport = nonEmptyString(item.transport, `${source}: servers[${index}].transport`);

	if (transport === "http") {
		const url = expandEnv(nonEmptyString(item.url, `${source}: servers[${index}].url`), env, source);
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`${source}: servers[${index}].url is not a valid URL`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error(`${source}: servers[${index}].url must use http or https`);
		}
		return { name, transport: "http", url };
	}

	if (transport !== "stdio") throw new Error(`${source}: servers[${index}].transport must be "stdio" or "http"`);
	const command = expandEnv(nonEmptyString(item.command, `${source}: servers[${index}].command`), env, source);
	let args: string[] | undefined;
	if (item.args !== undefined) {
		if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string")) {
			throw new Error(`${source}: servers[${index}].args must be an array of strings`);
		}
		args = item.args.map((arg) => expandEnv(arg as string, env, source));
	}
	let childEnv: Record<string, string> | undefined;
	if (item.env !== undefined) {
		if (!item.env || typeof item.env !== "object" || Array.isArray(item.env)) {
			throw new Error(`${source}: servers[${index}].env must be an object of string values`);
		}
		childEnv = {};
		for (const [key, value] of Object.entries(item.env as Record<string, unknown>)) {
			if (typeof value !== "string") throw new Error(`${source}: servers[${index}].env.${key} must be a string`);
			childEnv[key] = expandEnv(value, env, source);
		}
	}
	return {
		name,
		transport: "stdio",
		command,
		...(args ? { args } : {}),
		...(childEnv ? { env: childEnv } : {}),
	};
}

export function loadMcpServersFile(path: string, env: NodeJS.ProcessEnv = process.env): ServerConfig[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path}: cannot read MCP config: ${String((error as Error)?.message ?? error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path}: root must be an object`);
	const servers = (parsed as Partial<McpServersFile>).servers;
	if (!Array.isArray(servers)) throw new Error(`${path}: servers must be an array`);
	const validated = servers.map((server, index) => validateServer(server, index, env, path));
	const names = new Set<string>();
	for (const server of validated) {
		if (names.has(server.name)) throw new Error(`${path}: duplicate server name ${JSON.stringify(server.name)}`);
		names.add(server.name);
	}
	return validated;
}

export function discoverMcpConfig(options: DiscoverMcpConfigOptions): LoadedMcpConfig {
	const env = options.env ?? process.env;
	const explicit = env.WEA_MCP_CONFIG?.trim();
	if (explicit) {
		const path = isAbsolute(explicit) ? explicit : resolve(options.cwd, explicit);
		if (!existsSync(path)) throw new Error(`WEA_MCP_CONFIG points to a missing file: ${path}`);
		return { servers: loadMcpServersFile(path, env), source: path, fallback: false };
	}

	const candidates = [
		resolve(options.cwd, ".pi/mcp.servers.json"),
		resolve(options.homeDir, ".pi/agent/mcp.servers.json"),
		...(options.extraPaths ?? []).map((path) => (isAbsolute(path) ? path : resolve(options.cwd, path))),
	];
	for (const path of candidates) {
		if (existsSync(path)) return { servers: loadMcpServersFile(path, env), source: path, fallback: false };
	}

	return { servers: options.fallbackServers(), source: "built-in workspace filesystem server", fallback: true };
}
