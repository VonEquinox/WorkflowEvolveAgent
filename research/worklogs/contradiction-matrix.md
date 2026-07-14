# Contradiction Matrix

> Topic: 基于图结构 Workflow IR 的自进化 Coding Agent
> Last updated: 2026-07-13

| ID | Finding A (ledger) | Finding B (ledger) | Apparent contradiction | Conditions / differences | Reconciliation | Status | Next check |
|---|---|---|---|---|---|---|---|
| C1 | TBD | TBD | 图结构提高并行/共享能力，但图通信和 judge 会增加 token 与时延 | 静态 DAG vs 动态 MAS；工具节点 vs LLM 节点 | 需按算子/任务类型测净收益，不宣称图总优于树 | Open | WS3/WS4 evidence |
| C2 | TBD | TBD | single-trace attribution 廉价，但真实边际贡献是反事实量 | observational proxy vs causal estimand | 用 proxy 做筛选，少量 LOO 做校准，永久剪枝需跨运行证据 | Open | WS0/WS5 evidence |
| C3 | TBD | TBD | semantic reuse 提高命中率，但可能 silent contamination | exact dependency-equivalent vs approximate intent-similar | 三档缓存，semantic/adapt 默认需 verifier 或只读低风险任务 | Open | WS2 evidence |
| C4 | TBD | TBD | 模板复用降低搜索成本，但固定模板可能抑制探索/适应 | familiar vs out-of-distribution tasks | uncertainty gate + fallback planner + challenger | Open | WS7/WS8 evidence |
| C5 | TBD | TBD | 自进化追求在线改善，但统计噪声会造成模板漂移 | per-task feedback vs held-out aggregate evidence | archive + promotion gate + rollback；不在线覆盖 champion | Open | WS8 evidence |
