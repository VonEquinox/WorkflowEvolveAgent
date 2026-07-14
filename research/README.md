# WorkflowEvolutionAgent Research Workspace

原始 v0.1 研究计划已经被拆成可审计、可并行、可验证的 v0.2 方案，并附带最小可执行原型。

## 首要入口

- `../SELF_EVOLVING_AGENT_RESEARCH_PLAN_v0.2.md`：收敛后的总体方案、roadmap、验收和 kill criteria。
- `../PI_INTEGRATION_PLAN.md`：**当前实施主文档**——在 pi 上构建的架构、决策 D6–D18、Phase 0–5 与 MCP bridge 子项目。
- `reports/00_PLAN_AUDIT_AND_REFRAME.md`：原文问题、创新重定位和范围审计。
- `OPEN_ISSUES.yaml`：开放问题、优先级、负责人、状态和验收条件。
- `worklogs/evidence-ledger.md`：截至 2026-07-13 核验的一手来源和证据边界。

## 并行研究报告

1. `reports/01_CREDIT_ASSIGNMENT_AND_METRICS.md`
2. `reports/02_TRACE_AND_SAFE_REUSE.md`
3. `reports/03_DYNAMIC_DAG_SCHEDULER.md`
4. `reports/04_FANIN_LOOPS_BROADCAST.md`
5. `reports/05_WORKFLOW_IR_AND_DISTILLATION.md`
6. `reports/06_RETRIEVAL_AND_GRAPH_EDITING.md`
7. `reports/07_SELF_EVOLUTION_STABILITY.md`
8. `reports/08_FRAMEWORK_AND_BENCHMARK_SURVEY.md`
9. `reports/09_ARCHITECTURE_RED_TEAM.md`

## 可执行原型

- `../schemas/*.schema.json`：Graph/Trace/Workflow/Artifact/Certificate/Contracts schemas。
- `../tools/validate_ir.py`：零第三方依赖 structural + fail-closed semantic validator。
- `../examples/valid/`、`../examples/invalid/`：合法/非法 conformance fixtures。
- `../prototypes/attribution.py`：artifact-level PVF attribution 与 metrics CLI。
- `../prototypes/scheduler.py`：event-driven dynamic DAG scheduler simulator。
- `../tests/`：schema、attribution、scheduler 共 29 个测试。

## 当前推荐起点

1. 用 OpenHands Software Agent SDK 做首个 Trace IR adapter；
2. 只启用 hermetic deterministic operator 的 EXACT reuse；
3. 采集 50–200 条统一 trace；
4. 运行 PVF + 小样本 LOO calibration；
5. 数据证明值得后，再做 semantic reuse、蒸馏、graph editing 和自动 promotion。
