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

After install, CLI:
  ./bin/wea help
  ./bin/wea run --task "..." --offline-plan
  ./bin/wea gui

Interactive Pi MCP bridge (one command):
  pi install git:github.com/VonEquinox/WorkflowEvolveAgent && pi

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
bold "Installing Pi package / MCP bridge launcher"
(
  cd "$ROOT"
  npm install --no-fund --no-audit
)
chmod +x "$ROOT/bin/wea-mcp" 2>/dev/null || true
ok "Pi package dependencies + $ROOT/bin/wea-mcp"

bold "Installing @wea/runner"
(
  cd "$ROOT/runner"
  npm install --no-fund --no-audit
)
ok "runner dependencies"

# CLI launcher
chmod +x "$ROOT/bin/wea" 2>/dev/null || true
if [[ -d "$ROOT/runner/node_modules/.bin" ]]; then
  ln -sfn "$ROOT/bin/wea" "$ROOT/runner/node_modules/.bin/wea" 2>/dev/null || true
fi
ok "CLI: $ROOT/bin/wea  (or: cd runner && npm run wea -- …)"

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
# Copy to .env (gitignored) or export in your shell for control-assisted planning.
# Any Anthropic-messages-compatible endpoint works.

WEA_BASE_URL=https://your-endpoint.example/v1
WEA_API_KEY=sk-...
WEA_MODEL=your-model-id

# Optional control transport settings (defaults shown)
# WEA_CONTROL_TIMEOUT_MS=60000
# WEA_CONTROL_MAX_RETRIES=2

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
  (
    cd "$ROOT"
    npm run test:pi-extension
  )
  ok "mcp-bridge: resident MCP + reuse + installable Pi extension"
else
  warn "skipped self-tests (--skip-test)"
fi

# ---- summary --------------------------------------------------------------
echo
bold "Install complete"
cat <<EOF

Next steps:

  1) Offline checks (no model calls)
       (cd runner && npm test && npm run smoke)

  2) Real run (needs a configured pi default worker model)
       cp .env.example .env   # optional: enables control-assisted planning
       set -a && source .env && set +a
       ./bin/wea run --task "fix the failing test" \
         --template auto --repo /path/to/target --out runs
       ./bin/wea gui          # browser UI, same real execution path

  3) Docs
       README.md          English
       README.zh-CN.md    中文

Interactive Pi MCP bridge (installs from GitHub and opens Pi):
       pi install git:github.com/VonEquinox/WorkflowEvolveAgent && pi

The Pi package adds the MCP-over-bash bridge. The full graph orchestrator remains
available through ./bin/wea run and ./bin/wea gui.
EOF

if [[ "$START_GUI" -eq 1 ]]; then
  echo
  bold "Starting GUI on http://127.0.0.1:7788  (Ctrl+C to stop)"
  cd "$ROOT/runner"
  exec npm run gui
fi
