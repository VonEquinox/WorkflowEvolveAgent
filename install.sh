#!/usr/bin/env bash
# WorkflowEvolveAgent — one-shot local install
# Usage:
#   ./install.sh              # deps + offline self-tests
#   ./install.sh --skip-test  # deps only
#   ./install.sh --gui        # deps + tests + start web GUI
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_TEST=0
START_GUI=0

for arg in "$@"; do
  case "$arg" in
    --skip-test) SKIP_TEST=1 ;;
    --gui) START_GUI=1 ;;
    -h|--help)
      cat <<'EOF'
WorkflowEvolveAgent installer

  ./install.sh              Install deps and run offline self-tests
  ./install.sh --skip-test  Install deps only
  ./install.sh --gui        Install, test, then start the web GUI

Requirements: Node.js >= 20, npm, bash
EOF
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

bold "WorkflowEvolveAgent install"
echo "  root: $ROOT"
echo

# ---- Node -----------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node not found — install Node.js >= 20"
command -v npm  >/dev/null 2>&1 || die "npm not found"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  die "Node.js >= 20 required (found $(node -v))"
fi
ok "Node $(node -v) / npm $(npm -v)"

# ---- packages -------------------------------------------------------------
bold "Installing @wea/runner"
(
  cd "$ROOT/runner"
  npm install --no-fund --no-audit
)
ok "runner dependencies"

bold "Installing @wea/mcp-bridge"
(
  cd "$ROOT/mcp-bridge"
  npm install --no-fund --no-audit
)
ok "mcp-bridge dependencies"

# ---- env example ----------------------------------------------------------
ENV_EXAMPLE="$ROOT/.env.example"
if [[ ! -f "$ENV_EXAMPLE" ]]; then
  cat > "$ENV_EXAMPLE" <<'EOF'
# Copy to .env (gitignored) or export in your shell before a live run.
# Any Anthropic-messages-compatible endpoint works.

WEA_BASE_URL=https://your-endpoint.example/v1
WEA_API_KEY=sk-...
WEA_MODEL=your-model-id

# Optional GUI port (default 7788)
# WEA_GUI_PORT=7788
EOF
  ok "wrote .env.example"
else
  ok ".env.example already present"
fi

# ---- offline checks -------------------------------------------------------
if [[ "$SKIP_TEST" -eq 0 ]]; then
  bold "Offline self-tests (no API spend)"
  (
    cd "$ROOT/runner"
    npm test
    npm run smoke
  )
  ok "runner: retrieval / cache / champion + smoke traces"

  (
    cd "$ROOT/mcp-bridge"
    npm test
  )
  ok "mcp-bridge: resident MCP + reuse"
else
  warn "skipped self-tests (--skip-test)"
fi

# ---- summary --------------------------------------------------------------
echo
bold "Install complete"
cat <<EOF

Next steps:

  1) Offline demo (no endpoint)
       cd runner && npm run gui
       open http://127.0.0.1:7788   # Simulate mode

  2) Live run (needs Anthropic-messages endpoint)
       cp .env.example .env   # then edit values
       set -a && source .env && set +a
       cd runner
       npx tsx src/run.ts --task "fix the failing test" \\
         --template auto --repo /path/to/target --out runs

  3) Docs
       README.md          English
       README.zh-CN.md    中文

Note: WEA embeds the pi SDK as a library (createAgentSession per graph node).
It is not installed into the interactive \`pi\` TUI by this script.
EOF

if [[ "$START_GUI" -eq 1 ]]; then
  echo
  bold "Starting GUI on http://127.0.0.1:7788  (Ctrl+C to stop)"
  cd "$ROOT/runner"
  exec npm run gui
fi
