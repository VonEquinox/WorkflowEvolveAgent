/**
 * Wire protocol between the thin `wea-mcp` CLI and the resident bridge.
 *
 * One request per line, one response per line — newline-delimited JSON over a
 * unix socket (same philosophy as pi's --mode rpc). The CLI is short-lived (it
 * is just a bash command); the bridge that answers is session-lived.
 */

export type BridgeRequest =
	| { cmd: "list"; server?: string }
	| { cmd: "search"; query: string; detail?: "name" | "full" }
	| { cmd: "describe"; tool: string }
	| { cmd: "call"; tool: string; args: unknown };

export interface ToolBrief {
	/** fully-qualified "server.toolName". */
	id: string;
	server: string;
	name: string;
	description: string;
	/** from MCP annotations — drives cache eligibility (read-only ⇒ reusable). */
	readOnly: boolean;
	destructive: boolean;
}

export interface BridgeResponse {
	ok: boolean;
	/** present when ok:false */
	error?: string;
	/** search/list → briefs */
	tools?: ToolBrief[];
	/** describe → one tool's full schema */
	tool?: ToolBrief & { inputSchema: unknown };
	/** call → structured result */
	result?: {
		isError: boolean;
		/** concatenated text content the tool returned. */
		text: string;
		/** sha256 of `text`, for trace/cache keys (bridge computes it). */
		digest: string;
		/** the tool's read/destructive hints, echoed for the caller/recorder. */
		readOnly: boolean;
		destructive: boolean;
		/** true when served from the exact cache (read-only reuse, B2). */
		cached: boolean;
	};
}

/** Default socket path for a session id (CLI and bridge must agree). */
export function socketPathFor(sessionId: string, dir = "/tmp"): string {
	// keep it short & filesystem-safe; unix socket paths are length-limited (~104).
	const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 32);
	return `${dir}/wea-mcp-${safe}.sock`;
}

/** Environment variable the CLI reads to find its bridge socket. */
export const SOCKET_ENV = "WEA_MCP_SOCKET";
