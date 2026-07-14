# WorkflowEvolveAgent

A self-evolving, observable coding-agent workflow system built as a **pi**
extension, in pure TypeScript. It runs a graph of agent nodes on a task, records
everything as a trace, attributes credit, retrieves the right workflow, safely
reuses pure results, lets a trusted meta-agent redesign a workflow, and promotes
a redesign only when it **wins a paired comparison** — plus an MCP-over-bash
bridge that gives nodes external tools without flooding their context.

> Runtime: pi SDK (`@earendil-works/pi-coding-agent`), Node ≥ 20, TypeScript.
> Endpoint: any Anthropic-messages-compatible API.
> 中文说明: [README.zh-CN.md](./README.zh-CN.md) · One-shot install: [`./install.sh`](./install.sh)

## The idea

A coding agent's one-shot call tree becomes a **graph** you can replay, attribute,
reuse, and evolve: plan a workflow → assign agents → run → post-mortem where the
waste is → distill into better templates → get better with use. Safety does not
come from forbidding the AI's ideas; it comes from **measurement** — a redesign
only becomes the default by beating the current one on real tasks.

## Repository

```
runner/        @wea/runner — the execution + evolution runtime (TypeScript)
  src/
    graph.ts          event-driven scheduler (ALL/ANY_SUCCESS, SEAL, bounded loops, retry)
    node-session.ts   node ↔ pi AgentSession (per-node prompt + model; JSON output)
    recorder-ext.ts   pi InlineExtension: tool/usage capture, redaction, self-digests
    budget.ts         run-level hard budget → abort on overrun
    trace-export.ts   RunManifest → dual trace surface (compliance + PVF)
    library.ts        load templates + agent cards
    run.ts            CLI event loop (parallel spawn, retry, verdict-aware status)
    rebuild.ts / smoke-export.ts   offline trace (re)build, no endpoint
    retrieval.ts      Phase 3: TaskCard → rule router + BM25 → pick a workflow
    cache.ts          Phase 4: content-addressed exact reuse, fail-closed
    meta-improve.ts   redesign step: postmortem → wea.proposal/v2 → gate → challenger
    template-edit.ts  trusted applier + structural gate (executability only, D28)
    champion.ts       Phase 5: judge challenger vs champion; promote/rollback by alias
    selftest.ts       offline checks for Phases 3–5 (npm test)

library/       the workflow library (versioned, source-controlled)
  templates/   t0-direct · t1-safe-generic · t2-bugfix · t3-complex (+ auto challengers)
  agents/      inspector · implementer · verifier · explorer · aggregator · meta-improver

mcp-bridge/    @wea/mcp-bridge — MCP-over-bash: one bash command reaches any MCP
               server through a session-lived resident connection; results stay in
               the shell (rg/jq/--out) instead of flooding the model's context
```

Each component has its own README: [`runner/README.md`](runner/README.md),
[`mcp-bridge/README.md`](mcp-bridge/README.md).

## The trust model

The meta-agent is **trusted** to redesign a workflow however it judges best —
remove a verifier, rebuild the whole graph, swap models. Nothing vetoes an idea
for being "unsafe". The structural gate only checks that a redesign *executes*
(edges reference real endpoints, @input reaches @output, no cycle outside a
FEEDBACK loop, no orphan). Safety lives in the **champion gate**: a redesign is a
*challenger* and replaces the current template only by winning a paired
comparison — non-inferior quality, a real efficiency gain, and no material
regression on any axis. If it loses, the champion stands and is never destroyed.
Power comes from winning the measurement, not from being permitted. The one
physical guardrail — trial runs must not cause irreversible external side effects
— is a sandbox property, not a limit on the AI's judgment.

## Quick start

### One-shot install

```bash
git clone https://github.com/VonEquinox/WorkflowEvolveAgent.git
cd WorkflowEvolveAgent
chmod +x install.sh
./install.sh              # deps + offline self-tests
# ./install.sh --gui      # same, then open the web UI
# ./install.sh --skip-test
```

### Manual

```bash
cd runner && npm install
npm test         # offline: Phases 3–5 (retrieval, exact reuse, champion gate)
npm run smoke    # offline: synthesize a run → both trace surfaces
npm run gui      # web UI at http://127.0.0.1:7788 — task in, live DAG +
                 # per-agent progress out; Simulate mode needs no endpoint

# a real run needs an Anthropic-messages endpoint (see .env.example):
export WEA_BASE_URL=... WEA_API_KEY=... WEA_MODEL=...
npx tsx src/run.ts --task "node test.js fails: ... fix it" \
  --template auto --repo /path/to/target-repo --out runs
```

```bash
cd mcp-bridge && npm install
npm test              # end-to-end against a real filesystem MCP server (21 checks)
bash scripts/e2e.sh   # the model's real shell chain: search → call --out → rg
```

## What's proven vs. pending

- **Proven, live:** T2 fixes a real bug end-to-end; T3 adds a real feature; the
  meta-agent autonomously proposed removing a redundant explorer and the gate
  produced a runnable challenger.
- **Proven, offline:** retrieval routing; fail-closed exact cache; champion
  promote/reject/rollback (including correctly rejecting a noisy A/B as
  "inconclusive, run more pairs"); the full MCP bridge against a real server —
  resident connection reuse, progressive disclosure, structured trace
  observation, read-only exact reuse, fail-closed classification.
- **Pending (wiring, not new work):** multi-pair A/B on a stable endpoint;
  hooking the exact cache into the runner's spawn loop; wiring the MCP bridge
  extension into runner node sessions; worktree write-isolation; per-node budget.

## Design record

Key decisions are logged as D-numbers in the design history (kept local). The
load-bearing one here is **D28**: safety moved from restricting proposals to
measuring results — trust the AI, gate only executability, let the champion
comparison decide.
