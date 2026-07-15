# @wea/runner

A self-evolving coding-agent workflow runtime on top of the **pi** SDK, in pure
TypeScript. It runs a graph of agent nodes on a task, records everything as a
trace, attributes credit, retrieves the right workflow for a task, safely reuses
pure results, lets a trusted meta-agent redesign a workflow, and promotes a
redesign only when it **wins a paired comparison**.

## Quick start

```bash
# Node >= 20 required (pi-tui uses the `v` regex flag).
cd runner && npm install

npm test        # offline self-test for Phases 3–5 (no network, no API spend)
npm run smoke   # offline: synthesize a run → emit both trace surfaces
npm run gui     # web UI at http://127.0.0.1:7788 — see below

# A run needs a configured pi default worker model. WEA_* is optional and
# enables control-assisted planning/adaptation; otherwise retrieval is offline.
export WEA_BASE_URL=... WEA_API_KEY=... WEA_MODEL=...
npx tsx src/run.ts --task "node test.js fails: ... fix it" \
  --template auto --repo /path/to/target-repo --out runs
```

## GUI

`npm run gui` serves a local web UI (127.0.0.1:7788): type a task, pick a
template (or `auto`), and watch the run live — the workflow DAG with each node's
status (waiting / ready / running / succeeded / failed), what every agent is
doing right now (tool calls, tokens, cost as they happen), a live activity feed,
and per-node detail (role, division of labor, recent activity, final JSON
output). FEEDBACK loops render as dashed return edges.

There is one execution path: real pi AgentSessions in a detached per-run Git
worktree. The GUI and CLI drive the same orchestrator (`src/orchestrator.ts`).
`WEA_*` is only for the control plane; when absent, template selection falls
back to offline retrieval while workers still use the configured pi default.

Switch the GUI to **Edit graph** to create a workflow from a blank canvas or
revise the latest saved template. Nodes are draggable; source/target ports create
edges; the inspector edits node roles, prompts, budgets, DATA/CONTROL/FEEDBACK
edges, and bounded loops. The server runs the same runtime Graph Schema before
saving. New graphs become immutable `1.0.0` base files; edits become exact patch
revisions and never overwrite an existing template. Editor positions are stored
as optional top-level `ui.positions` metadata and are ignored by the scheduler.

`--template auto` (the default) lets **retrieval** pick the workflow from the
task; pass an explicit id (`--template t2-bugfix`) to override. If a family has a
promoted champion version, the runner uses it automatically.

Each run writes `runs/<template>-<runid>.{trace,pvf,manifest}.json`:
`*.trace.json` is the compliance trace (`wea.trace/v1`), `*.pvf.json` is the PVF
attribution input (`wea.pvf.trace/v1`), `*.manifest.json` is the internal record
(`npx tsx src/rebuild.ts <manifest>` rebuilds the two trace surfaces offline).

## Modules

```
src/
  # L1/L2 — execution + capture
  types.ts         graph / budget / record shared types
  graph.ts         scheduler: ALL_SUCCESS/ANY_SUCCESS + SEAL + dependency-failure
                   propagation + bounded FEEDBACK loops + bounded node retry
  budget.ts        run-level hard budget (tokens/$/wall); over-budget → abort()
  recorder-ext.ts  pi InlineExtension: tool_call/result/usage capture, path
                   normalization, sensitive-path redaction, self-computed digests
  node-session.ts  node ↔ AgentSession (per-node prompt + model override; tolerant
                   JSON-output parsing)
  library.ts       load library/templates/*.json + library/agents/*.md
  template-service.ts GUI list/validate/create/revise with immutable versions
  trace-export.ts  RunManifest → dual trace surface (compliance + PVF projection)
  orchestrator.ts  the real execution loop as an event-emitting function;
                   both the CLI and the GUI drive it
  workspace.ts     detached per-run worktree + review patch capture
  run.ts           CLI front over the orchestrator
  gui-server.ts    local web UI server: static + JSON API + SSE event stream
  gui/editor-model.js pure graph mutations used by the visual editor + tests
  rebuild.ts       rebuild traces from a manifest offline
  smoke-export.ts  offline: synthetic manifest → both trace surfaces

  # L3/L4 — retrieval, reuse, evolution
  retrieval.ts     Phase 3: TaskCard → rule router + BM25 over template shape → pick
  cache.ts         Phase 4: content-addressed exact reuse, fail-closed (pure/
                   read-only only; bash/writes never cached; any world change misses)
  meta-improve.ts  redesign step: postmortem + template → wea.proposal/v2 (open
                   edit vocabulary) → structural gate → challenger version
  template-edit.ts trusted applier + structural gate (executability only, NOT a
                   safety review — safety is the champion gate, D28)
  champion.ts      Phase 5: judge a challenger vs champion from paired metrics;
                   promote only on non-inferior quality + real gain + no regression;
                   move an alias on a win, hold on a loss; releases never deleted
  selftest.ts      offline checks for Phases 3–5 (npm test)
```

Templates: `library/templates/` (t0-direct / t1-safe-generic / t2-bugfix /
t3-complex, plus any auto-generated `<id>@<version>.json` challengers). Agent
cards: `library/agents/` (inspector / implementer / verifier / explorer /
aggregator / meta-improver) — pi-subagent frontmatter + system prompt, all
bound to a JSON output contract.

## The trust model (D28)

The meta-agent is **trusted**: it may redesign a template however it judges best
— remove a verifier, rebuild the whole graph, swap models. Nothing vetoes an idea
for being "unsafe". The structural gate only checks that the redesign *executes*
(edges reference real endpoints, @input reaches @output, no cycle outside a
FEEDBACK loop, no orphan). Safety lives in the champion gate: a redesign is a
**challenger** and replaces the current template only by winning a paired
comparison; if it loses, the champion stands and is never destroyed. Power comes
from winning the measurement, not from being permitted. The one physical
guardrail — trial runs must not cause irreversible external side effects — is a
sandbox property, not a limit on the AI's judgment.

## Optional: IR validation & PVF (local Python)

The trace surfaces conform to `wea.trace/v1` and `wea.pvf.trace/v1`. A local,
zero-dependency Python validator (`tools/validate_ir.py`) and PVF attributor
(`prototypes/attribution.py`) live in the research tree (not shipped here); they
consume these JSON files directly if you have them:

```bash
python3 tools/validate_ir.py     runs/<run>.trace.json
python3 prototypes/attribution.py runs/<run>.pvf.json --pretty
```

## What's proven vs. pending

- Proven end-to-end (live): T2 fixes a real bug; T3 adds a real feature; the
  meta-agent autonomously proposed removing a redundant explorer and the gate
  produced a runnable challenger.
- Proven offline (`npm test`): retrieval routing, fail-closed exact cache,
  champion promote/reject/rollback — including correctly rejecting a noisy A/B
  as "inconclusive, run more pairs".
- Pending: multi-pair A/B on a stable endpoint, exact-cache spawn integration,
  MCP bridge injection into node sessions, and automated champion promotion.
```
