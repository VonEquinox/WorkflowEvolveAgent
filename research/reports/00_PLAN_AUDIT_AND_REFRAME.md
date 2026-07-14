# 原研究计划问题审计与重构建议

> 日期：2026-07-13  
> 审计对象：`SELF_EVOLVING_AGENT_RESEARCH_PLAN.md` v0.1  
> 结论：方向有价值，但当前文档把多个独立研究问题绑定成一个大闭环，且 2025–2026 的近邻工作已经使部分 novelty 表述过时。应先收窄论文主张，再按“观测 → 精确复用 → 调度 → 归因校准 → 模板库 → 受控进化”推进。

## 一、最重要的结论

1. **原计划列出的开放问题是真问题，但不是同一阶段的问题。** WS0–WS8 至少包含 instrumentation、构建系统式缓存、在线调度、程序分析/因果归因、图挖掘、检索、架构搜索和安全在线学习八类课题；一次性全部做完，研究范围接近多个项目。
2. **原来的宽泛创新主张已不成立。** EvoMAC（ICLR 2025）已经在软件开发场景中根据测试反馈调整 multi-agent workflow；SEW（2025）直接演化 code-generation multi-agent workflow；DGM（2025）在 SWE-bench 上自修改 coding agent；Socratic-SWE（2026）从历史 traces 蒸馏技能并闭环进化；MermaidFlow（ICLR 2026 submission）提出 typed graph IR 与受约束图编辑。详见 `research/worklogs/evidence-ledger.md`。
3. **仍有可守住的窄创新点。** 当前近邻工作并未明确同时解决：repository-state-aware 的 content-addressed subtask result reuse、consumer/provenance trace、single-trace attribution proxy 与小规模 LOO 校准、typed executable IR 的 retrieve-and-constrained-edit、以及 champion gate 下的端到端 token/latency/pass-rate 评测。
4. **“无重跑 credit assignment”不能直接称为真正因果归因。** 真实边际贡献是反事实量。单次 trace 最多提供 observational proxy；2026 年的 *Agents that Matter* 进一步报告 introspective LLM judge 不能可靠替代 agent ablation。因此应把目标改成“高精度安全剪枝筛选器”，并用少量 LOO 校准。
5. **语义去重必须默认保守。** exact reuse 与 semantic reuse 是两个不同产品：前者可通过依赖闭包和 repo snapshot 做 soundness；后者若仅靠 embedding，会产生 silent contamination。MVP 只默认开启 exact reuse，semantic/adapt 仅限只读、可验证、低风险节点。
6. **benchmark 不应表述为‘完全不存在’。** SWE-bench 官方 experiments repo 已有部分 logs/trajs/patches；真正缺的是统一的、完整 sub-agent graph + per-node cost + data-consumer edges + counterfactual labels。因此项目应定位为“构建标准化派生 trace benchmark”，而非从零声称没有轨迹。

## 二、文档内部的 15 个结构性问题

### P0：novelty statement 过宽且已经过时

原文“没有任何单一工作把整条缝起来”若作为弱表述仍可能成立，但正文多处暗示“coding workflow 自进化 / 图作为可优化 IR / trace 复用”分别无人覆盖。2025–2026 工作已覆盖其中大块：

- EvoMAC：软件开发 multi-agent network，测试反馈 + textual backprop 更新 prompts/workflow，并动态增删 agents。
- SEW：自动构造和演化 code-generation workflow，优化拓扑与 prompts。
- DGM：在 coding benchmarks 上自修改 agent code，使用 archive 和 benchmark gate。
- Socratic-SWE：从历史 coding traces 蒸馏 skills，并生成/验证新任务驱动多轮进化。
- MermaidFlow：typed declarative graph IR、静态验证、correctness-preserving mutation。
- MaAS / FlowReasoner：query-conditioned architecture/workflow 生成。

**修正**：把主张收窄为“dependency-sound reuse + trace-calibrated attribution + typed IR retrieval/editing 的统一 repository-level coding system”。

### P1：把 runtime trace graph 与 reusable workflow IR 混成同一张图

两者语义不同：

- **Execution Trace Graph** 是一次运行的事实记录，包含尝试、失败、重试、动态展开、实际读写和成本。
- **Workflow Template IR** 是可执行计划，包含允许的控制流、参数槽位、资源/权限、终止条件和不变量。

直接把 trace “沉淀为 IR”会把偶然错误路径、重试和任务特定细节带入模板。

**修正**：定义双层模型，trace 是 event-sourced instance；template 是经对齐、筛选、参数化和验证后的 canonical source。graph view 和 retrieval index 都从 canonical template 派生，不能成为第三个独立真相源。

### P2：content-addressing 与 semantic equivalence 混淆

content hash 只能证明“被编码进 key 的内容相同”，不能证明任务语义等价；embedding 相似只能说明表示接近，不能证明可替换。

**修正**：采用三档复用：

1. `EXACT`：任务规格、工具/模型版本、权限、repo dependency snapshot、输出 schema 全相同；可自动命中。
2. `SEMANTIC_VERIFIED`：相似候选 + 明确 applicability predicate + verifier 通过；默认仅只读任务。
3. `ADAPT`：旧结果作为输入，由 adapter 生成新结果并重新验证；计入新的节点成本，不伪装成 cache hit。

### P3：consumer 关系不等于贡献

输出被读取不代表有用；未被读取也不代表结构性无用，例如保险性 verifier、备份分支、使 orchestrator 有信心停止的负证据。

**修正**：consumer/provenance 只作为归因特征。永久剪枝必须满足：跨运行低价值后验 + 少量 LOO 校准 + 风险等级允许 + held-out 不退化。

### P4：WS0 与 WS5 实际重复

两者都在定义 effective contribution、single-trace attribution、结构性冗余。重复会造成指标和算法两套口径。

**修正**：

- WS0 只定义 **estimand、trace schema、metrics、benchmark protocol**。
- WS5 定义 **estimators、calibration、pruning policy**。

### P5：WS1 与 WS6 对 IR 的定义冲突

WS1 称执行图为图 IR；WS6 又重新讨论 Workflow IR 表示选型。若不拆分，schema 会既像 telemetry 又像 DSL。

**修正**：统一命名：

- `Trace IR`：不可变事件/执行事实。
- `Workflow IR`：版本化可执行模板。
- `Materialized Graph View`：从两者投影出的分析视图。

### P6：没有显式 repo/environment state model

coding agent 的缓存正确性取决于文件、Git tree、依赖锁、生成物、环境变量、工具版本、权限和网络输入。原 schema 只有“关键上下文”，不足以失效缓存。

**修正**：节点输入必须声明 `declared_reads`、运行后记录 `observed_reads`，并绑定 content digest；外部不可固定输入标为 volatile，禁止跨运行复用。

### P7：没有 side-effect、事务与幂等语义

“改文件”“提交 Git”“发 issue”“运行迁移”等节点不能像纯分析节点一样重放或共享。动态调度、失败恢复与环都会触发重复副作用。

**修正**：为每个节点声明 effect class：`PURE_READ`、`SANDBOX_WRITE`、`COMMIT_WRITE`、`EXTERNAL_SIDE_EFFECT`；只有前两类可自动 retry，写入节点使用隔离 worktree、幂等键和两阶段 commit。

### P8：没有并发写冲突模型

图允许多个 implementer 并行，但它们可能修改同一文件或语义相邻区域，fan-in 时冲突。

**修正**：调度前声明/预测 write set；保守地对重叠 write set 加 mutex；未知 write set 在独立 worktree 执行，聚合时做三方 merge + build/test verifier。

### P9：图结构收益被默认化，没有把图的开销纳入目标

更多边、广播、judge 和反馈环本身会消耗 token/时延。2026 年 cyclic graph 对照研究显示，循环在某些环境有恢复收益，但在前置依赖强的任务上简单前向执行更好，且循环图可能显著更贵。

**修正**：优化目标使用净效用，而不是“图越丰富越好”：

`utility = pass_value - λ_token*token - λ_time*wallclock - λ_risk*risk - λ_complexity*graph_complexity`

任何新增边/节点/环都必须在 held-out 上证明正的增量效用。

### P10：KV cache 与 subtask result cache 混在一起

SGLang/RadixAttention 复用 prompt prefix 的 KV；本项目想复用的是带语义、repo 状态和工具结果的节点输出。两者的 key、失效和正确性完全不同。

**修正**：分两层计量和实现：`inference_prefix_cache` 与 `workflow_result_cache`；分别报告命中率与节省，不把 KV 命中算作任务去重。

### P11：“per-task 微调”术语含糊

它可能被理解为模型权重 fine-tuning，但正文实际是 graph editing / architecture adaptation。

**修正**：改名为“query-conditioned constrained workflow adaptation”，明确 action space、hard constraints、最大编辑预算与 fallback。

### P12：闭环更新缺少统计门禁

单任务成功/失败噪声很大，直接写回模板会漂移。原文提到 champion-challenger，但没有 promotion criterion。

**修正**：候选模板不能覆盖 champion；按任务簇做 paired evaluation，使用置信下界和 non-inferiority gate；流程为 offline replay → shadow → canary → promote；任何回归自动回滚。

### P13：评测没有充分的 baseline 与 ablation

只和“tree baseline”比较不足以证明每个组件的价值。

**修正**：至少包括：

- tree baseline；
- trace-only（不优化）；
- exact reuse only；
- scheduler only；
- retrieval only；
- retrieval + slot fill；
- retrieval + constrained edit；
- attribution proxy pruning；
- oracle/LOO small subset；
- full closed loop。

同时固定模型、token budget、工具权限和任务采样，报告 pass rate、cost、latency、critical path、cache precision 和回归率。

### P14：没有阶段性 kill criteria

若 exact duplicate rate 很低，或 attribution proxy 与 LOO 不相关，后续系统应转向别的价值主张，而不是继续堆功能。

**修正**：每个里程碑加停止条件，见后文 roadmap。

## 三、建议的新研究主张

### 主张 A：可观测性

> 能否用与 OpenTelemetry 兼容、但增加 repo state、data consumption 和 effect semantics 的 Trace IR，完整重放/分析 coding-agent execution graph？

**成功条件**：≥95% 节点有完整 parent/dependency/cost；≥90% 文件读取可归因到节点；trace replay/visualization 可用。

### 主张 B：安全复用

> 在不降低 patch pass rate 的前提下，dependency-sound exact memoization 能否减少重复 repo exploration 和工具调用？

**成功条件**：false reuse 为 0（测试集中）；token 或 tool-time 中位数下降 ≥10%；cache hit 的依赖证书可解释。

### 主张 C：归因与受控改进

> single-trace attribution proxy 能否高精度筛出可删除/可合并节点，并在 champion gate 下逐步改善 workflow？

**成功条件**：在 LOO 标注子集上 deletion precision ≥0.9；held-out pass rate non-inferior；综合效用显著提高；任何候选可回滚。

## 四、重新排序的 roadmap

### v0 — Trace-first benchmark

- 定义 Trace IR 与 effect/dependency semantics。
- instrument 一个可控 agent runtime。
- 自采 50–200 个 SWE-bench Lite/Verified 或真实 repo tasks。
- 建立 tree baseline、成本计量、trace viewer、理想去重上界。

**Kill criteria**：若 instrumentation 无法捕获实际文件依赖/节点边界，先限制 runtime，不做跨框架通用 instrumentation。

### v1 — Exact reuse + deterministic scheduler

- 只对 `PURE_READ`、确定性工具、固定 repo snapshot 做 exact memoization。
- online list scheduler；write-set isolation；idempotent retry。
- 与无缓存/串行 baseline 对照。

**Kill criteria**：若 exact duplicate token share <5%，不把去重作为主论文贡献，转向 trace benchmark/scheduling。

### v1.5 — Attribution calibration

- 实现 provenance survival、consumer coverage、novelty/duplication、verifier evidence 等 proxy。
- 在小子集做 node/coalition removal，得到反事实标签。
- 学习或校准风险分层 pruning threshold。

**Kill criteria**：若安全删除 precision <0.8 或跨 repo 崩溃，只保留可视化诊断，不自动剪枝。

### v2 — Template IR + retrieval

- 从成功 trace 蒸馏 typed canonical workflow。
- 先做 task-cluster retrieval + slot filling，不做自由图编辑。
- 模板必须通过 schema、effect、cycle、budget、permission 静态校验。

**Kill criteria**：retrieval+slot fill 不优于 cold planner，则不进入 learned editor。

### v3 — Constrained adaptation

- 仅允许有限 action：增删 optional node、替换 operator、调整 fan-out、插入 verifier、修改预算。
- 小规模 beam/bandit search；候选均在 sandbox 验证。

### v4 — Champion-gated evolution

- archive、版本、paired held-out gate、shadow/canary、回滚。
- 进化对象先限定为 Workflow IR，不修改 runtime、安全规则或 evaluator。

## 五、现在真正待解决的问题（优先级）

| 优先级 | 问题 | 当前可解决程度 | 建议动作 |
|---|---|---|---|
| P0 | Trace IR 与 repo/effect semantics | 高，可直接工程化 | 立即定 schema + validator |
| P0 | exact reuse 的依赖闭包与失效 | 高，可借鉴构建系统 | MVP 默认只支持纯读节点 |
| P0 | benchmark/基线与消融 | 高 | 先自采，不等公共集 |
| P0 | novelty 重定位 | 高 | 重写 1.4、相关工作与论文主张 |
| P1 | single-trace attribution proxy | 中，只能先做近似 | 与 LOO 小样本校准，不声称因果 |
| P1 | 动态调度与写冲突 | 中高 | online list scheduling + worktree isolation |
| P1 | typed Workflow IR | 中高 | canonical executable spec + graph/retrieval views |
| P2 | semantic/adaptive reuse | 中低，风险高 | 只在 verifier 强、只读节点实验 |
| P2 | constrained graph editing | 中 | 先规则/beam，再考虑学习式 |
| P2 | 自进化稳定性 | 中 | archive + gate 可工程化；单调改进不可保证 |
| P3 | 通用跨框架 instrumentation | 低且成本高 | 先支持一个 runtime，后做 adapters |

## 六、建议修改原文的关键句

原句：

> 没有任何单一工作把……整条缝起来。

建议：

> 截至 2026-07-13，EvoMAC、SEW、DGM、Socratic-SWE、GPTSwarm、MaAS/FlowReasoner 和 MermaidFlow 已分别覆盖 coding workflow 自适应、agent 自修改、trace-to-skill、图优化与 query-conditioned architecture 等大块能力。仍缺少公开系统在 repository-level coding 场景中统一实现并严格评测：依赖正确的 content-addressed subtask result reuse、consumer-aware execution tracing、经反事实校准的 single-trace attribution proxy、typed executable workflow IR 的检索/受约束编辑，以及 champion-gated evolution。本文只主张并验证这一更窄的组合。

## 七、建议新增的非算法要求

- 安全与隐私：secret/PII 不进入 cache key 或共享输出；按 workspace/tenant 隔离缓存。
- 可重现性：记录 model/provider/version、sampling params、prompt/tool schemas、container image、repo commit。
- 权限：模板声明工具权限，adaptation 不得扩大权限。
- 评价隔离：evaluator、tests、promotion policy 不允许被 evolution agent 修改。
- 成本核算：token、tool CPU、GPU、wall-clock、失败重试、缓存存储都计入总成本。
- 人工可审计：每次模板晋级附 diff、证据、风险与回滚点。
