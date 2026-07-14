# @wea/mcp-bridge

**MCP-over-bash bridge.** The model sees *one* tool — `bash` — and reaches any
number of MCP servers through a single command, `wea-mcp`. Results come back into
the shell (stdout or a `--out` file), where the model filters them with `rg` /
`jq` / `>` **before** anything enters its context. That is where the token savings
come from: tool schemas aren't preloaded (progressive disclosure), and large
results never stream through the model twice. (Precedent: Anthropic's
*Code execution with MCP*, ~150k → 2k tokens on one task.)

## The shape

```
model (only has bash)
  └─ wea-mcp call gdrive.getDoc --json '{...}' --out /tmp/r.json   ← one bash command
        │                         (thin, short-lived CLI; connects to a unix socket)
        ▼
  resident McpBridge  ── session-lived, connections stay hot ──▶ real MCP servers
        │                         (returns structured result: text + digest + read-only flag)
        ▼
  /tmp/r.json          ← big result on disk, NOT in the model's context
        │
        ▼
  rg PATTERN /tmp/r.json  ·  jq '.rows[0]'  ·  > final.txt        ← model filters in the shell
```

Two halves, split by lifetime — this is the key design point:

- **Resident half (`bridge.ts`, `extension.ts`)** — a pi `InlineExtension`. When a
  pi session starts it connects every configured MCP server **once** and keeps
  them hot; every `wea-mcp call` reuses those warm connections; at session end it
  disposes them. Its lifetime **is** the session's lifetime.
- **Thin half (`cli.ts`)** — `wea-mcp`, a short-lived process (it's just a bash
  command). It connects no servers; it forwards one JSON request to the resident
  bridge over the session's unix socket (`$WEA_MCP_SOCKET`) and prints the reply.

## Commands

```bash
wea-mcp list [--server NAME]                          # tools: name + one-line desc
wea-mcp search "keywords"                             # find tools (progressive disclosure)
wea-mcp describe server.tool                          # one tool's full input schema
wea-mcp call server.tool --json '{...}'               # small result → stdout
wea-mcp call server.tool --json '{...}' --out FILE    # big result → FILE (out of context)
```

Tools are tagged `[ro]` (read-only) and `[!]` (destructive) straight from the
server's MCP annotations.

## Observability & reuse (loosens D10)

A raw bash command (`curl …`) is volatile — its read-set is invisible, so it can
never be safely reused. A call **through the bridge** is fully structured
(`server + tool + explicit args + read-only annotation`), which buys two things a
raw shell call cannot:

- **B1 — observe:** every call becomes a structured trace observation
  (`mcp_call`: server, tool, args-digest, result-digest, read-only) — auditable,
  not an opaque blob.
- **B2 — reuse:** a read-only, non-destructive call is exact-cacheable within the
  session, keyed by `(server, tool, canonical args)`. An identical repeat returns
  the stored bytes with a certificate and **never touches the server**. Anything
  destructive, errored, or not annotated read-only is **never cached**
  (fail-closed) — `reuse.ts`.

## Config

Copy `mcp.servers.example.json` → `mcp.servers.json` and list your servers
(`stdio` command or `http` url; `env` values may reference `$VARS`). Secrets stay
in env / the gitignored config — never in the repo.

## Verify

```bash
npm install
npm test        # end-to-end against a real @modelcontextprotocol/server-filesystem:
                # resident connect + hot reuse + progressive disclosure + B1 observe
                # + B2 read-only cache + fail-closed classification (21 checks)
bash scripts/e2e.sh   # the model's real shell chain: search → call --out → rg
```

## Using it from the runner

```ts
import { makeMcpBridgeExtension } from "@wea/mcp-bridge/src/extension.ts";

const mcp = makeMcpBridgeExtension({ sessionId, servers, onCall: recordIntoTrace });
// add mcp.factory to DefaultResourceLoader extensionFactories;
// await mcp.ready before prompting; call mcp.dispose() after session.dispose().
```

The extension sets `$WEA_MCP_SOCKET` (pi's bash inherits `process.env`) and, on
`before_agent_start`, prepends a short usage note so the node knows `wea-mcp`
exists and to keep big results out of context. Each runner node session gets its
own resident bridge on its own socket — parallel nodes never cross wires.
