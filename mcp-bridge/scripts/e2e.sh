#!/usr/bin/env bash
# B0c end-to-end — the MODEL's real shell chain against a real MCP server.
#
# Starts a resident bridge (as the pi extension would), then drives the ACTUAL
# thin `wea-mcp` CLI exactly as the model's bash would: discover → fetch-to-file
# (kept out of context) → filter in the shell. Exits non-zero on any failure.
#
# Run:  bash scripts/e2e.sh   (needs Node >= 20 on PATH)

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TSX="$ROOT/node_modules/.bin/tsx"
FS_SERVER="$ROOT/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js"
SANDBOX="$(mktemp -d)"
SOCK="$SANDBOX/bridge.sock"
printf 'alpha line\nNEEDLE in haystack\nomega line\n' > "$SANDBOX/notes.txt"

fail=0
check() { if eval "$2"; then echo "  ✓  $1"; else echo "  ✗ FAIL  $1"; fail=1; fi; }

# --- resident bridge (session-lived) ---
cat > "$SANDBOX/bridge.mjs" <<EOF
import { McpBridge } from "$ROOT/src/bridge.ts";
const fs = { name:"fs", transport:"stdio", command:"node", args:["$FS_SERVER","$SANDBOX"] };
const b = new McpBridge([fs], "$SOCK");
await b.start(); console.error("BRIDGE_READY");
process.on("SIGTERM", async()=>{ await b.dispose(); process.exit(0); });
setTimeout(()=>{}, 600000);
EOF
"$TSX" "$SANDBOX/bridge.mjs" 2>"$SANDBOX/bridge.log" &
BPID=$!
trap 'kill $BPID 2>/dev/null || true; rm -rf "$SANDBOX"' EXIT

for _ in $(seq 1 30); do grep -q BRIDGE_READY "$SANDBOX/bridge.log" && break; sleep 0.5; done
grep -q BRIDGE_READY "$SANDBOX/bridge.log" || { echo "bridge failed to start"; cat "$SANDBOX/bridge.log"; exit 1; }

export WEA_MCP_SOCKET="$SOCK"
wea_mcp() { "$TSX" "$ROOT/src/cli.ts" "$@"; }

echo "MCP bridge e2e — model's shell chain"
# 1) discover
SEARCH="$(wea_mcp search 'read text file' || true)"
check "wea-mcp search finds a read tool" '[[ "$SEARCH" == *read* ]]'
# 2) fetch to file — result stays OUT of the model's context
RECEIPT="$(wea_mcp call fs.read_text_file --json "{\"path\":\"$SANDBOX/notes.txt\"}" --out "$SANDBOX/r.txt")"
check "call --out returns only a short receipt" '[[ "$RECEIPT" == *wrote* && ${#RECEIPT} -lt 200 ]]'
check "receipt does NOT leak the body to stdout" '[[ "$RECEIPT" != *NEEDLE* ]]'
# 3) filter in the shell (rg if present, else grep)
if command -v rg >/dev/null 2>&1; then HIT="$(rg NEEDLE "$SANDBOX/r.txt" || true)"; else HIT="$(grep NEEDLE "$SANDBOX/r.txt" || true)"; fi
check "shell filter finds the needle in the fetched file" '[[ "$HIT" == *NEEDLE* ]]'
# 4) small call inline (no --out) prints straight to stdout
INLINE="$(wea_mcp call fs.read_text_file --json "{\"path\":\"$SANDBOX/notes.txt\"}")"
check "small call without --out prints contents inline" '[[ "$INLINE" == *NEEDLE* ]]'

echo ""
if [[ $fail -ne 0 ]]; then echo "E2E FAILED"; exit 1; fi
echo "E2E PASSED — one bash command; results stay in the shell; filtered before context."
