# Research Plan

> Research date: 2026-07-13
> Topic: 基于图结构 Workflow IR 的自进化 Coding Agent
> Scope: 核验创新主张，并把 WS0–WS8 的开放问题收敛为一个可实现、可证伪的 v0→v1 方案。
> Requested output: 问题审计、架构决策、算法草案、schemas、MVP backlog、评测与风险门禁。
> Constraints / budget: 当前仓库只有研究计划，无代码/轨迹数据；优先一手论文、官方文档与官方仓库；直接证据不足时必须标注为相邻证据或推断。
> Current framing: 不是一次性“发明完整自进化系统”，而是先证明三个可独立检验的主张：可观测、可安全复用、可受控改进。

## Key unknowns / risks

- 单次 trace 的归因能否与反事实 LOO 足够相关，还是只能作为保守筛选信号。
- 语义去重是否能在 coding agent 的可变 repo 状态下做到低误复用。
- 三层 IR 是否真的比纯代码/纯图/纯自然语言更可执行且更可泛化。
- 在线图编辑的收益是否超过搜索、验证与回滚开销。
- 文档中的“完整链路尚无单一工作覆盖”是否经得住 2025–2026 新工作核验。

## Status Legend

- `Open`
- `Searching`
- `Partially answered`
- `Supported`
- `Refuted`
- `Inconclusive but bounded`
- `Deprioritized`

## Research Questions

| ID | Category | Question / Claim | Why it matters | Priority | Evidence needed | Hypotheses | Status | Next action |
|---|---|---|---|---|---|---|---|---|
| Q1 | Measurement | single-trace attribution 能否作为节点价值的可靠近似？ | 决定复盘/剪枝是否成立 | High | primary papers + trace/LOO calibration experiment | H1,H2 | Searching | agent A + attribution sources |
| Q2 | Safety | content-addressed exact/semantic reuse 如何避免 silent contamination？ | 决定最大效率收益是否安全 | High | build systems + semantic caching + coding-state evidence | H3,H4 | Searching | agent B + counterexamples |
| Q3 | Representation | graph/code/retrieval 三层 IR 是否是最小充分表示？ | 决定蒸馏、检索、编辑接口 | High | agent workflow papers + executable IR comparisons | H5,H6 | Searching | agent E |
| Q4 | Scheduling | 动态展开图能否通过 online DAG scheduler 降低 wall-clock？ | 决定并行收益 | Medium | systems papers + scheduler design | H7 | Searching | agent C |
| Q5 | Control | fan-in/feedback/lateral communication 何时有净收益？ | 图相对树的核心结构收益 | Medium | graph reasoning/MAS papers + failure cases | H8 | Searching | agent D |
| Q6 | Adaptation | per-task graph editing 是否优于检索后参数实例化？ | 决定 v4 复杂度是否必要 | High | architecture search/query-conditioned workflow evidence | H9,H10 | Searching | agent F |
| Q7 | Stability | 自进化闭环如何保证不退化、不遗忘、可回滚？ | 决定能否上线与长期运行 | High | self-improving agents + safe online deployment | H11 | Open | 待释放 agent 槽位 |
| Q8 | Benchmark | 如何构造带图/token/结果/反事实标签的数据集？ | 所有算法的验证底座 | High | SWE-bench harness + tracing feasibility | H12 | Partially answered | 先做自采最小集 |
| Q9 | Novelty | 端到端链路是否已有 2025–2026 工作覆盖？ | 论文定位与选题风险 | High | broad academic search + citation chasing | H13,H14 | Searching | 主代理 falsification pass |

## Current Loop Focus

- Highest-priority open questions: Q1, Q2, Q3, Q7, Q9
- Planned broadening searches: graph workflow memory, trace attribution, semantic cache soundness, self-improving coding agents
- Planned academic discovery passes: arXiv IDs in原计划；Google Scholar-style citation/related work；2025–2026 近邻工作
- Planned falsification searches: “self-evolving workflow graph coding agent”, “semantic cache false hit”, “agent graph optimization failure”, “single trace attribution limitations”
- Sources that must be fetched next: 原计划附录核心论文、OpenTelemetry semantic conventions、LangGraph/runtime docs、SWE-bench harness
- Most important contradictions to resolve: 更灵活的图结构 vs 通信/判断开销；单次归因廉价 vs 因果可信度；语义复用命中率 vs soundness

## Exit Readiness

- High-priority questions already resolved: none at initialization
- Hypotheses still untested: H1–H14
- Contradictions handled: none at initialization
- Remaining unresolved gaps to disclose if stopping now: exact causal validity, cross-repo generalization, 2026 novelty
- What would change my mind (top 3 evidence requests): public end-to-end system with identical loop；large-scale trace/LOO correlation data；semantic reuse false-positive benchmark
