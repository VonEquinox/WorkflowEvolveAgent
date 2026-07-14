# 研究计划：基于图结构 Workflow IR 的自进化 Coding Agent
> Self-Evolving Coding Agent with Graph-structured Workflow IR
> 版本 v0.1 · 状态：待调研 · 本文件用于分发给其他模型做分工调研
---

## 1. 项目总览：要做什么

### 1.1 一句话
现在的 coding agent 调用过程本质是**一棵一次性的调用树**（orchestrator 开 sub-agent，sub-agent 再开 sub-sub-agent，结果向上回传）——跑完即弃、分支间重复劳动、无法复盘、无法进化。本项目要把它改造成一个**可复盘、可复用、会自我进化的图结构系统**：

1. **Tree → Graph**：把调用过程从树泛化为 **content-addressed 执行图**（支持去重、并行、聚合、反馈）。
2. **执行图 = Workflow IR**：把这张图沉淀成**可检索、可编辑、可参数化**的中间表示（IR）。
3. **复盘归因**：每次任务跑完，在图上做 credit assignment——找出**浪费 token / 对结果无贡献**的 sub-agent，更新 IR 库。
4. **检索 + 微调**：新任务从 IR 库检索最相近的 workflow 模板，做少量结构微调后执行。
5. 以上构成闭环 → **self-evolve**。

### 1.2 核心闭环
```
        ┌─────────────────────────────────────────────┐
        │                                             │
   execute(graph) ──▶ postmortem / credit-assignment ─┤
        ▲                     │                        │
        │                     ▼                        │
   retrieve + adapt ◀── distill → Workflow IR ◀────────┘
   (per-task 微调)          (存入 / 更新 IR 库)
```

### 1.3 "Tree → Graph" 的四种正交推广（贯穿全项目的设计主线）
| 代号 | 加了什么结构 | 买到什么 | 主要落在哪个 WS |
|---|---|---|---|
| **A. 树→DAG** | 多父指向同一子节点（重汇聚） | **共享子结果、去重、记忆化 → 省 token** | WS2 |
| **B. 横向边** | sibling 间通信（黑板/广播） | 一个分支的发现让别的分支少走弯路 | WS4 |
| **C. 聚合节点** | 多产出 → fan-in（map-reduce/投票） | 树只擅长 fan-out，图能 fan-in 做综合 | WS4 |
| **D. 环** | verifier→implementer 回退循环 | 迭代精化、失败重试 | WS4 |

### 1.4 与现状的差距（本项目的空位）
据前期调研，**没有任何单一工作把「coding agent 调用树 → 内容寻址图 → 去重复用 sub-agent 结果 → 图作为可检索可编辑的 workflow IR → 复盘归因反哺 self-evolve」整条缝起来**。
- 图化推理/多智能体图（GoT, GPTSwarm, MacNet）有图，但不针对 coding agent 去重、也不学习进化；
- DAG 效率工作（LLMCompiler, SGLang, Parrot）有去重/并行，但不沉淀 IR、不进化；
- 图剪枝（AgentPrune, AGP）剪冗余通信，但不把结构沉淀成可复用 IR；
- workflow memory（AWM）诱导 routine，但不做 token 归因、不做图调度。
**把它们缝合，是本项目主张的创新点。**

---

## 2. WS0 — 问题定义与度量（一切的地基，最先做）

**目标**：把"浪费""有没有贡献""高效"变成可测量的量，并搭出评测底座。没有它，后面所有"优化"都无法验证。

**待解决——算法问题**
- 如何定义一个 sub-agent 的**边际贡献 / effective contribution**？候选：它的输出是否被下游节点真正 consume（读取/引用）；leave-one-out 重跑后结果是否变差（贵）；信息流追踪（它的 token 有没有流入最终 diff）。
- **无重跑归因**：LOO/Shapley 要重复执行，成本爆炸。能否只用**一次执行的 trace** 就归因？这是全项目最硬的算法问题之一。
- 如何区分"这次碰巧没用"与"结构性冗余"（每次都没用）？需要跨多次运行的统计。

**待解决——工程问题**
- **轨迹 instrumentation 格式**：需要一个 agent 版的 trace 规范（类似 OpenTelemetry span，但记录 task 语义、输入上下文、token、耗时、父子/依赖关系、consumer 关系）。
- **缺 benchmark**：目前没有公开的、带完整 sub-agent 图 + 每节点 token + 最终结果的 coding-agent 轨迹数据集。要么自采（跑现有 agent 采轨迹），要么基于 SWE-bench 构造。

**调研产出**
1. 一份**度量定义文档**：redundancy rate（重复子任务占比）、effective-contribution score、critical-path 长度、cache-hit rate、token/任务、通过率。每个指标给出**可仅从单次 trace 计算**的近似算法。
2. 一份**评测方案**：baseline（现有 tree agent）如何对照；用哪些任务集。
3. **调研**：多智能体 credit assignment / attribution 的现有做法（种子：DyLAN importance score、AgentPrune、removal-based attribution〔编号存疑，需核验〕）。

---

## 3. WS1 — 执行图数据模型与轨迹记录（对应 roadmap v0）

**目标**：定义图 IR 的 schema 和 content-addressing 方案；把现有 coding agent 的调用树完整记录成图（本阶段**只观测、不改行为**）。

**参考 schema（待细化）**
```
Node {
  id
  task:        语义描述（"理解 auth 模块" / "改 login.py" / "跑测试"）
  input_hash:  content-addressed key = hash(task 语义 + 纳入的关键上下文)
  output
  cost:        {tokens, wallclock}
  consumers:   哪些下游节点真正读了本节点 output   ← 归因用
}
Edge { type: data-dep | control-dep | lateral-broadcast ; from ; to }
```

**待解决——工程问题**
- 如何 instrument 现有 agent（如 Claude Code / OpenHands / SWE-agent / AutoGen）把 tree 落成 graph？哪些有 hook / callback 能拿到 sub-agent 边界？
- trace 的存储与可视化（让人先"看见"浪费）。

**待解决——算法问题**
- **content-addressing 的 key 设计**：哪些上下文要纳入 hash，才能既最大化去重命中、又不误判两个其实不同的子任务为相同？（这是 WS2 安全去重的前置。）
- **节点粒度**：task 级 vs 更细。粒度对去重率、管理开销、归因精度的 trade-off。

**调研产出**：图 IR schema 草案 + 至少 1 个现有 agent 的 instrumentation 可行性报告 + trace 格式建议（可参考 OpenTelemetry / LangSmith trace）。

---

## 4. WS2 — 去重 / 记忆化 / 共享子结果（roadmap v1，升级 A，**收益最大**）

**目标**：让不同分支复用同一个子结果（如多个 implementer 共享同一个"repo map / 代码库理解"节点），而不是各自重复探索。这是砍 token 浪费的主战场。

**待解决——算法问题（本 WS 最危险的点）**
- **语义等价判定**：两个子任务何时"等价到可以复用"？完全 hash 命中太严（几乎不命中），embedding 相似又可能误复用导致**结果污染**。需要安全的判定准则。
- **近似复用**：结果需要轻微 adapt 才能用（如"读文件 A 并总结"，但下游关注点不同）——可行吗？怎么判定 adapt 成本 < 重算成本？
- **失效（invalidation）**：代码库在跑的过程中被修改，缓存的"理解"何时失效？（构建系统的 dirty-tracking 问题。）

**待解决——工程问题**
- memoization cache 的实现、key 索引、失效传播。
- 与推理层的结合：相同 prompt 前缀能否走 KV-cache 复用（SGLang RadixAttention 思路）。

**调研产出**：安全复用判定准则设计 + 失效策略 + 收益上界估计（用 WS1 的 trace 算"如果理想去重能省多少 token"）。
**种子文献**：Build Systems à la Carte（记忆化 DAG 增量重建，ICFP'18）；SGLang/RadixAttention `2312.07104`。

---

## 5. WS3 — DAG 并行调度（roadmap v1，效率）

**目标**：把执行图做拓扑调度，无依赖的节点并行跑，缩短 critical path。

**待解决——算法问题**
- **动态图调度**：边往往运行到一半才知道（agent 决定要不要再开子任务）——在结构未完全已知时如何调度？
- 推测执行（speculative execution）值不值得：提前跑可能用得上的节点。
- critical-path 识别与优化。

**待解决——工程问题**：依赖解析、并发控制、限流（API rate limit）、失败重试与部分结果处理。

**调研产出**：调度算法设计 + 现有系统对照。
**种子文献**：LLMCompiler `2312.04511`（工具调用规划成 DAG 并行）；Parrot `2405.19888`〔核验作者，MSR/OSDI'24〕；SGLang `2312.07104`。

---

## 6. WS4 — Fan-in 聚合与反馈环（roadmap v2/v3，升级 B/C/D）

**目标**：加入聚合节点（merge / vote / verify）与反馈环（critic→implementer 回退）。

**待解决——算法问题**
- **聚合策略**：多分支产出如何合并？投票 / LLM-judge / 结构化 merge（如多个 diff 的合并）各自适用场景。
- **环的收敛判据与终止**：verifier↔implementer 必须有预算 + 收敛条件防死循环。何时判定"改不动了，该放弃/上报"？
- **横向广播（升级 B）**：一个分支的发现广播给谁、何时广播、如何防止信息过载。

**待解决——工程问题**：环的状态管理（借鉴 LangGraph 状态机）、预算记账、聚合节点的并发同步。

**调研产出**：聚合算子清单 + 环终止判据设计。
**种子文献**：Graph of Thoughts `2308.09687`（聚合/合并思维）；Mixture-of-Agents `2406.04692`〔核验编号〕；LangGraph（工程）；self-consistency `2203.11171`（投票 fan-in）。

---

## 7. WS5 — 复盘归因 / 图剪枝（核心创新：找出浪费的 sub-agent）

**目标**：每次任务跑完，在执行图上判定"谁浪费 token、谁没贡献"，为 IR 更新与下次剪枝提供信号。

**待解决——算法问题**
- **图上的 credit assignment**：给定一次执行的 trace（节点 cost + consumer 关系 + 最终结果），如何归因每个节点的价值？
- **便宜近似**：LOO/Shapley 太贵，找 trace-only 的代理信号（consumer 追踪、信息流分析、注意力/引用分析）。
- **结构性剪枝 vs 单次剪枝**：单次没用 ≠ 该永久删。需要跨运行统计 + 谨慎的剪枝策略（保留探索性节点）。

**待解决——工程问题**：归因结果的存储与可视化；把剪枝决策安全地写回 IR 模板。

**调研产出**：至少 2 种 trace-only 归因算法设计 + 与重跑式（LOO）归因的对比实验方案。
**种子文献**：AgentPrune/Cut the Crap `2410.02506`；DyLAN `2310.02170`〔核验编号，含 agent importance score〕；removal-based attribution `2605.27621`〔**编号存疑，务必核验**〕；Adaptive Graph Pruning `2506.02951`〔核验〕。

---

## 8. WS6 — Workflow IR 的表示、蒸馏与库（核心）

**目标**：把跑得好的执行图蒸馏成**可复用、可参数化**的 workflow 模板，建立可检索的 IR 库。

**待解决——算法问题**
- **IR 表示选型**（关键决策）：自然语言 routine（易检索、难精确编辑）vs 代码（可执行/可 diff、难泛化）vs 图（表达拓扑、语义弱）。**能否三层混合**：code-as-IR（可 patch）+ graph view（做归因/剪枝）+ retrieval memory（按任务取）？——**这是本项目最值得主打的技术选择，需专门论证。**
- **模板蒸馏 = frequent subgraph mining**：从多条执行图里挖出反复出现的高价值子结构，抽成模板。
- **参数化**：模板里哪些是可变槽位（文件名、模块、语言），哪些是固定骨架？

**待解决——工程问题**：IR 库的存储、版本化、索引与相似度检索。

**调研产出**：IR 表示方案对比报告（含推荐）+ 子图蒸馏算法设计。
**种子文献**：AWM `2409.07429`（诱导可复用 routine）；ADAS `2408.08435`（code archive）；ExpeL `2308.10144`（经验 insight 库）；Voyager `2305.16291`（skill library）；GPTSwarm `2402.16823`（图作为可优化 IR）。

---

## 9. WS7 — 检索 + 每任务微调（核心）

**目标**：新任务来了，从 IR 库检索最相近的 workflow 模板，做少量结构微调后执行。

**待解决——算法问题**
- **workflow 检索**：用什么 key 匹配任务与模板（任务 embedding？任务特征？）。
- **结构微调 = graph editing**：如何对模板做加/删/改节点与边以适配当前任务？是搜索、学习式编辑、还是 per-query 采样？
- 冷启动：库为空时的行为。

**待解决——工程问题**：检索索引；模板实例化（把参数化槽位填入当前任务）。

**调研产出**：检索 + graph-editing 方案设计。
**种子文献**：MaAS `2502.04180`（按 query 从 supernet 采样子图）；GPTSwarm `2402.16823`（优化边）；FlowReasoner `2504.15257`〔核验，per-query 生成 MAS〕。

---

## 10. WS8 — 自进化闭环与评测（集成）

**目标**：把 WS1–WS7 串成闭环并验证它**真的越跑越好**，而不是漂移到更差。

**待解决——算法问题**
- **进化稳定性**：闭环会不会退化？如何防止（held-out 验证、回滚、保留 champion 模板）。
- **灾难性遗忘**：更新 IR 库时别把已有的好模板冲掉。
- online learning 的探索/利用平衡。

**待解决——工程问题**：IR 库版本化、A/B、回滚、champion-challenger 机制。

**调研产出**：闭环评测协议 + 稳定性保护机制设计。
**评测**：在 SWE-bench（或真实 repo 任务）上对比 tree baseline 的 token、通过率、时延、随迭代次数的曲线。
**种子文献**：Darwin Gödel Machine `2505.22954`（archive + benchmark 验证的自进化）；Gödel Agent `2410.04444`；Reflexion `2303.11366`。

---

## 11. WS9 —（可选加分）管理学 / 组织理论视角

**目标**：给项目的"story/framing"加深度，可能贡献设计原则。

**调研问题**
- 组织设计理论（**矩阵型组织、共享服务中心 shared-services、绩效归因**）能否映射成 agent 拓扑设计原则？
  - 树 = 严格科层制；图 = 矩阵制 + 共享服务；"共享子结果节点" = 共享服务中心。
  - "复盘归因裁掉浪费 agent" = 绩效管理 / 组织重组。
- 现有工作把人类 SOP 硬编码进 agent（MetaGPT），但**没有"按绩效反过来重写 SOP/组织结构"的闭环**——这正是本项目的自进化。
**种子文献**：MetaGPT `2308.00352`；ChatDev `2307.07924`〔核验〕。

---

## 12. Top 开放问题清单（按价值/难度，供优先攻关）

| # | 问题 | 属于 | 为什么难/重要 |
|---|---|---|---|
| 1 | **无重跑的 credit assignment**：仅凭单次 trace 判定 sub-agent 贡献 | 算法 | 重跑太贵；这是"找浪费"的地基 |
| 2 | **安全语义去重**：何时可复用子结果而不污染结果 | 算法 | 误复用会静默出错，最危险 |
| 3 | **IR 表示选型 + 子图蒸馏**：混合 code/graph/retrieval，从轨迹挖参数化模板 | 算法 | 决定整个 IR 库能不能用 |
| 4 | **per-task 结构微调（graph editing）** | 算法 | 复用的关键；纯检索不够 |
| 5 | **自进化稳定性**：不漂移、可回滚、不遗忘 | 算法/工程 | 决定闭环能不能长期跑 |
| 6 | **缺 benchmark**：带完整 sub-agent 图 + token + 结果的 coding-agent 轨迹数据集 | 工程 | 没有它一切无法验证 |
| 7 | **动态图调度**：结构运行中才展开时如何并行 | 算法/工程 | 决定效率收益能否兑现 |

---

## 13. 现有系统 / 框架调研清单（需专人过一遍）

调研这些的**调用结构是 tree 还是已支持 graph、能否 instrument、有无复用/记忆化**：
- Coding agents：Claude Code、OpenHands（OpenDevin）、SWE-agent、Aider、Devin 类。
- 编排框架：LangGraph（图+环）、AutoGen、CrewAI、DSPy（`2310.03714`，编译式 pipeline）、MetaGPT。
- 推理服务层：SGLang、vLLM（前缀/KV 复用能力）。

---

## 附录 A — 已核验的种子文献（可信度已标）

**图例：✅ 高可信 ⚠️ 引用前必须核验编号**

**图化推理 / 多智能体图**
- ✅ Tree of Thoughts — Yao et al., 2023 — `2305.10601`
- ✅ Graph of Thoughts — Besta et al., 2023 — `2308.09687`（AAAI'24；树→图直接先例）
- ✅ GPTSwarm: Language Agents as Optimizable Graphs — Zhuge et al., 2024 — `2402.16823`（ICML'24）
- ⚠️ MacNet: Scaling LLM-based Multi-Agent Collaboration — Qian et al., 2024 — `2406.07155`
- ⚠️ DyLAN: Dynamic LLM-Agent Network — Liu et al., 2023 — `2310.02170`
- ⚠️ Mixture-of-Agents — J. Wang et al., 2024 — `2406.04692`
- ⚠️ Demystifying Chains, Trees, and Graphs of Thoughts — Besta et al., 2024 — `2401.14295`

**DAG / 效率 / 剪枝**
- ✅ LLMCompiler — Kim et al., 2023 — `2312.04511`
- ⚠️ Parrot (Semantic Variable, OSDI'24) — Chaofan Lin et al. (MSR) — `2405.19888`（核验作者）
- ✅ SGLang / RadixAttention — Zheng et al., 2023 — `2312.07104`
- ✅ AgentPrune / Cut the Crap — Guibin Zhang et al., 2024 — `2410.02506`
- ⚠️ Adaptive Graph Pruning (AGP) — Boyi Li et al., 2025 — `2506.02951`
- ⚠️ MaAS: Multi-agent Architecture Search via Agentic Supernet — G. Zhang et al., 2025 — `2502.04180`

**Workflow memory / 自进化 / 经验**
- ✅ Agent Workflow Memory — Wang, Mao, Fried, Neubig, 2024 — `2409.07429`
- ✅ ADAS: Automated Design of Agentic Systems — Hu, Lu, Clune, 2024 — `2408.08435`
- ✅ Darwin Gödel Machine — J. Zhang et al., 2025 — `2505.22954`
- ✅ Gödel Agent — Yin et al., 2024 — `2410.04444`
- ✅ Reflexion — Shinn et al., 2023 — `2303.11366`
- ✅ ExpeL — Zhao et al., 2024 — `2308.10144`（AAAI'24）
- ✅ Voyager — G. Wang et al., 2023 — `2305.16291`
- ✅ MetaGPT — Hong et al., 2023 — `2308.00352`
- ⚠️ ChatDev — `2307.07924` · AgentVerse — `2308.10848` · DSPy — `2310.03714` · TextGrad — `2406.07496` · FlowReasoner — `2504.15257` · Optima — `2410.08115` · removal-based attribution — `2605.27621`（**存疑**）

**非 arXiv 但真实**
- Build Systems à la Carte — Mokhov, Mitchell, Peyton Jones — ICFP 2018（记忆化 DAG 增量重建的理论）
- The Shift from Models to Compound AI Systems — BAIR blog, 2024（framing）
- LangGraph — 工程文档（带环的 agent 图）

---

## 附录 C — 里程碑 roadmap（WS 对应关系）
- **v0 观测**：WS0（度量）+ WS1（图记录）。先量化"树里有多少重复浪费"。
- **v1 去重+并行**：WS2 + WS3。**确定性收益最高，先做。**
- **v2 聚合**：WS4（fan-in）。
- **v3 反馈环**：WS4（环，注意终止判据）。
- **v4 学习进化**：WS5 + WS6 + WS7 + WS8，合流成自进化闭环。
