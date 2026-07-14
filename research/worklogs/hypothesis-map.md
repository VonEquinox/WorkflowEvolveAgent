# Hypothesis Map

> Topic: 基于图结构 Workflow IR 的自进化 Coding Agent
> Last updated: 2026-07-13

## Hypotheses

| ID | Hypothesis | Predictions / implications | Evidence for | Evidence against | Confidence | Status | Next test |
|---|---|---|---|---|---|---|---|
| H1 | provenance/consumer + downstream survival 的 single-trace score 可高召回识别明显无贡献节点 | 与 LOO 的“可安全删除”标签 AUROC/precision 可用；明显未消费节点得分低 |  |  | Med | Active | 小规模 LOO 校准 |
| H2 | 仅凭 single trace 无法估计真正边际因果贡献 | 对冗余备份、未触发保险节点、judge 偏差会误判 |  |  | High | Active | 搜反例并限制声明 |
| H3 | 只有依赖闭包完全纳入 key 的 exact reuse 才可默认安全 | exact hit false reuse 接近零；命中率较低 |  |  | High | Active | 定义 hermetic key |
| H4 | embedding 相似即可直接复用 | 命中率高且不降低 pass rate |  |  | Low | Active | falsification: semantic cache false hit |
| H5 | code + graph + retrieval metadata 三层 IR 是最小充分设计 | 可执行/可分析/可检索分别由三层承担，互相可导出 |  |  | Med | Active | 与纯表示对照 |
| H6 | 单一图 JSON 足以承担所有需求 | 无需额外 executable code 或 retrieval view |  |  | Low | Active | 检查表达/迁移/验证缺口 |
| H7 | online list scheduling + bounded speculation 能显著缩短动态 agent 图 critical path | wall-clock 降低且浪费 token 有上限 |  |  | Med | Active | trace simulator |
| H8 | fan-in 和反馈环只在有独立证据/可执行 verifier 时有净收益 | 无 verifier 时 judge 循环收益不稳/成本高 |  |  | Med | Active | 算子分层实验 |
| H9 | 受约束 graph editing 在模板失配任务上优于仅填槽 | hard tasks pass rate 提升，编辑成本可控 |  |  | Med | Active | retrieval-only vs edit ablation |
| H10 | 早期 MVP 不需要 learned graph editor | 规则/小搜索已覆盖主要收益 |  |  | Med | Active | complexity-adjusted baseline |
| H11 | archive + held-out gate + rollback 足以把自进化变成单调或有界退化过程 | champion 指标不下降；新模板先 shadow/canary |  |  | Med | Active | 设计统计门禁 |
| H12 | 先自采 50–200 条完整 trace 比等待公共 benchmark 更可行 | 可完成指标/上界/校准实验 |  |  | High | Active | instrumentation MVP |
| H13 | 尚无单一系统覆盖计划的完整闭环 | 搜索只发现局部组件 |  |  | Med | Active | 2025–2026 broad search |
| H14 | 已有近邻系统使“整条链路无人做”过强 | 至少一个系统覆盖图优化+记忆+自改进+coding |  |  | Med | Active | novelty falsification |
