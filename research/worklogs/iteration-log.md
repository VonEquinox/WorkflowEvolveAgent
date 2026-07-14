# Iteration Log

> Topic: 基于图结构 Workflow IR 的自进化 Coding Agent
> Start date: 2026-07-13

## Loop 1

- Goal: 审计原计划，把开放问题分解成可并行验证的假设与工程决策。
- Starting framing: 端到端 self-evolving graph workflow 系统。
- New terms added: execution graph, provenance attribution proxy, sound semantic memoization, three-layer IR, champion-challenger。
- Hypotheses updated: 初始化 H1–H14，保留成对竞争假设。
- Broadening searches run: 待主代理与 6 个并行子代理执行。
- Falsification searches run: 计划检索完整近邻系统、semantic cache false hit、agent graph overhead、single-trace causal limits。
- Sources added/fetched/verified: 初始化阶段尚无。
- What was learned: 原计划把“观测图”和“可执行模板图”、把“归因 proxy”和“因果 credit”、把“前缀缓存”和“子任务结果缓存”混在一起，必须拆层。
- What changed: v0 目标收敛为 trace schema + baseline dataset + offline upper-bound analysis；在线自进化后移。
- Contradictions found: C1–C5。
- Decisions recorded: D1–D5。
- Open gaps after this loop: 所有关键算法仍需一手证据和具体设计。
- Next loop plan: 收集并核验核心论文/官方文档；整合子代理报告；执行反例搜索。
- Stop-criteria status: 未满足。
