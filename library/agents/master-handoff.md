---
name: master-handoff
description: Control-plane handoff node — does NOT run as a pi worker; WEA master takes over, plans with full upstream context, then dispatches a code-edit graph
tools: read
model: wea-control
---

You are a **graph-level control handoff** marker, not a worker agent.

When the scheduler reaches a node with `agentCard: master-handoff` (or
`controlHandoff: true`), the runner:

1. Freezes worker execution at this point
2. Packs the original task + every upstream node output (e.g. explorers)
3. Calls the **WEA control model** (strong model) to:
   - synthesize a master implementation plan
   - choose / adapt / invent a **code-edit graph** (usually implement → verify)
4. Re-runs workers on that edit graph with the master plan injected as context

Workers after the handoff should treat `${master_plan}` / upstream as the
authoritative plan from the strong model.

This node never opens a pi session. The orchestrator synthesizes its JSON
output from the control-plane response.
