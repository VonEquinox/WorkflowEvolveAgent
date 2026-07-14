# 在 pi 上实现 Workflow Evolution 系统：调研结论与实施规划

> 日期：2026-07-13
> 状态：Phase 0 spike 完成（2026-07-14，§8 全部实测回填，见 `spikes/phase0/FINDINGS.md`），Phase 1 进行中
> 调研对象：`pi/`（earendil-works/pi-mono，commit `b084d2fb`，MIT License）
> 上位文档：`SELF_EVOLVING_AGENT_RESEARCH_PLAN_v0.2.md`（本文修订其 M0 的 runtime 选型）
> 定位：**工程实施计划**，不再论证 novelty。目标 = 让「AI 排 workflow → 分配 agent 干活 → 复盘归因 → 总结怎么分配 / 怎么写 prompt → 沉淀成模板 team → 越用越好」这条闭环真实跑起来。

---

## 0. 结论

**在 pi 上做，合理，且是目前能找到的最优宿主。不 fork 它的核心，以「SDK 外挂 + 扩展注入」方式构建。**

三条核心理由：

1. **我们要的采集点它全都有，且不用改核心代码。** 类型化 `tool_call`/`tool_result` 拦截（read/edit/write 事件自带文件路径 → read-set/write-set 免费拿到）；每条 assistant 消息自带 token+cost（`Usage`）；session 本身是 id/parentId 树结构 JSONL；SDK 可进程内起会话并订阅全事件流。
2. **多智能体编排的地基存在但足够空白。** 官方 subagent 只是示例扩展（spawn 子进程，single/parallel/chain 三模式），orchestrator 包仅 2k 行且标注 experimental——没有一个"钦定编排范式"挡路。我们的图调度器可以直接**成为**这一层，而不是绕开一个已有的层。
3. **体量可控、技术栈统一。** agent 核心 8.2k 行 TS、orchestrator 2k 行；全栈 TypeScript；MIT；活跃维护。对比：OpenHands 是重型 Python 系统、内部结构深；Claude Code 闭源，无法 instrument 到工具输入粒度；LangGraph 只给图运行时不给 coding agent，等于要自研另一半。

**对 v0.2 的修订**：M0 原定"首个 instrumentation target 采用 OpenHands Software Agent SDK"，改为 **pi**。OpenHands / SWE-agent 降级为后续 adapter 候选（decision D6）。

---

## 1. pi 现状盘点（截至 commit `b084d2fb`）

### 1.1 包结构

| 包 | 行数(src) | 用途 | 对我们的意义 |
|---|---|---|---|
| `packages/ai` | ~37k | 多 provider 统一 LLM API | 直接用，不碰 |
| `packages/agent` | ~8.2k | agent loop、工具调用、session 存储 | 事件源头，读懂即可，不改 |
| `packages/coding-agent` | ~53k | CLI、内置工具、扩展系统、SDK、RPC | **我们的挂载面**（SDK + extensions） |
| `packages/orchestrator` | ~2k | experimental：supervisor 管多个 pi RPC 进程 | 参考实现；远期分布式备用 |
| `packages/tui` | ~12k | 终端 UI | 不碰 |

### 1.2 与我们直接相关的八项能力（已逐一核实）

1. **SDK 进程内会话**（`packages/coding-agent/src/core/sdk.ts:34`）：`createAgentSession({ cwd, model, thinkingLevel, tools, excludeTools, customTools, sessionManager, resourceLoader })`。每会话可独立指定工作目录（→ worktree 隔离）、模型、工具白名单；`SessionManager.inMemory()` 支持无落盘会话；`InlineExtension` 可在创建时注入扩展，无需文件安装。
2. **扩展事件系统**（`packages/coding-agent/src/core/extensions/types.ts:839+`）：`tool_call` 事件按工具强类型（`ReadToolCallEvent`/`EditToolCallEvent`/`WriteToolCallEvent`/`BashToolCallEvent`…），输入参数（含路径）可读、可改、可 block；`tool_result` 可改写结果；`before_agent_start` 可按 turn 修改 system prompt；`agent_start/agent_end`、`turn_start/turn_end`、session 生命周期事件齐全；`pi.appendEntry()` 可把自定义条目持久化进 session。
3. **会话即事实记录**（`packages/coding-agent/docs/session-format.md`）：JSONL，v3 树结构（`id`/`parentId`，支持原地分支）；每条 `AssistantMessage` 带 `usage: {input, output, cacheRead, cacheWrite, cost{...}}`——**每次 LLM 调用的 token 与费用是原生记录的**。
4. **进程内事件流完备**（`packages/agent/src/types.ts:425-430`、`core/agent-session.ts:127`）：`tool_execution_start/update/end`、`message_start/update/end`、`agent_end(messages)`、`auto_retry_*`、`compaction_*`。订阅 `AgentSession.subscribe()` 即得全量。
5. **工具执行默认并行**（`packages/agent/src/agent-loop.ts:424`；`toolExecution` 默认 `"parallel"`，单工具可声明 `executionMode: "sequential"`）。
6. **headless 双通道**：`--mode rpc`（stdin/stdout JSONL 协议：prompt/steer/abort/fork/get_state）与 print mode。官方明确建议 TS 程序直接用 SDK 而非子进程（`docs/rpc.md`）。
7. **subagent 示例扩展**（`packages/coding-agent/examples/extensions/subagent/`）：agent 角色定义为 `agents/*.md`（frontmatter: name/description/tools/model + 正文 system prompt），spawn 独立 pi 进程、JSON 模式取回结构化输出，支持 single/parallel/chain。**这就是"team 成员卡片"的现成格式**，直接沿用并泛化。
8. **观测性有设计蓝图未实现**（`packages/agent/docs/observability.md`：trace/span 模型、`traceOperation()`；源码中尚无实现）。对我们无阻塞——扩展事件 + SDK 订阅已覆盖需求；上游日后实现则正好对齐我们的 Trace IR。

### 1.3 缺口清单（= 我们要建的东西）

| 缺口 | 影响 | 对策 |
|---|---|---|
| 无内置 subagent / 图编排 | 没有 fan-out/fan-in/loop | **建 wea-runner**（核心工作，§3） |
| 无跨节点结果复用 / cache | 分支重复劳动、token 浪费 | 建 content-addressed store（Phase 4） |
| 无复盘 / 归因 | 找不出浪费 | 复用已有 PVF 原型（Phase 2） |
| 无 repo snapshot 语义 | exact reuse 无依据 | runner 层做 git snapshot digest |
| `bash` 的 read-set 不可见 | bash 节点无法安全复用 | bash 视为 volatile，不参与复用（D10） |
| 无权限系统 | 节点可越权写 | 工具白名单 + worktree 隔离 +（远期）容器 |

---

## 2. 概念映射：v0.2 设计 ↔ pi 机制

| v0.2 概念 | 在 pi 上的落点 | 谁提供 |
|---|---|---|
| Node attempt（一次干活） | 一个 `AgentSession` 的一次 run（独立 context window） | pi SDK |
| 节点角色 / prompt artifact | `agents/*.md`（frontmatter + system prompt），内容寻址存储 | 沿用 subagent 示例格式 |
| WorkflowTemplate / Instance | 已有 `schemas/workflow-template|instance.schema.json` | 已有资产 |
| 图调度器（SEAL_NODE、readiness、预算） | **wea-runner**：TS 移植 `prototypes/scheduler.py` 语义，驱动多个 AgentSession | 我们建 |
| Trace IR | runner 图事件 + 节点内 recorder 扩展事件 → 合成 `schemas/trace.schema.json` 实例 | 我们建（薄转换层） |
| read/write dependency 捕获 | `tool_call` 类型化事件（read/grep/find/ls → read-set；edit/write → write-set） | pi 扩展事件，免费 |
| 每节点 token/cost/预算 | `message_end` 的 `Usage` 累加；超预算 `session.abort()` | pi 原生 + runner |
| 写隔离（SCHED-004） | 写节点跑在独立 git worktree（`createAgentSession({cwd})` 天然支持） | pi + runner |
| Artifact CAS | 节点输出（最终 assistant 消息 + 声明的输出文件）入内容寻址存储 | 我们建 |
| Exact reuse + certificate | runner 在 spawn 节点前查 cache；命中则 materialize、跳过执行 | 我们建 |
| PVF 归因 | `prototypes/attribution.py` 直接吃 Trace IR（离线，保持 Python） | 已有资产 |
| 复盘 meta-agent（总结经验、改 prompt） | 专用 pi session：输入 trace+PVF 报告，输出模板/prompt 修改**提案**（不直接生效） | pi + 我们的提示词 |
| 模板库 / 检索 | JSON 文件库 + TaskCard 规则/BM25 检索（v0.2 §8 的简化版） | 我们建 |
| Champion gate | 库层版本 + alias + paired 评测脚本 | 我们建（后期） |

**用户愿景六个动词的兑现位置**：排 workflow / 分配 agent → Phase 1+3；复盘 → Phase 2；总结怎么分配、怎么写 prompt → Phase 2 的 meta-agent；组成最高效 team 并持续提升 → Phase 5 champion-challenger。

---

## 3. 目标架构

```text
┌─────────────────────────────────────────────────────────────┐
│ L4 进化层（离线为主）                                          │
│   postmortem CLI（PVF 报告）· meta-agent（改进提案）           │
│   distiller（trace→模板）· champion gate（paired 评测）        │
├─────────────────────────────────────────────────────────────┤
│ L3 记忆层                                                     │
│   workflow library（templates/*.json + agents/*.md，版本化）  │
│   artifact CAS + reuse certificates · TaskCard 检索           │
├─────────────────────────────────────────────────────────────┤
│ L2 执行层：wea-runner（TS，进程内）                            │
│   模板实例化 → 图调度（readiness/并行/fan-in/loop/预算）        │
│   → 每节点 createAgentSession({cwd:worktree, tools, model})   │
│   → usage 监控/超支 abort → fan-in 聚合 → 结果提交             │
├─────────────────────────────────────────────────────────────┤
│ L1 采集层                                                     │
│   recorder inline extension（tool_call/result → read/write    │
│   set；message_end → usage）+ runner 图事件 → Trace IR JSONL  │
├─────────────────────────────────────────────────────────────┤
│ L0 pi 本体（npm 依赖 @earendil-works/pi-coding-agent，        │
│   锁定精确版本，不 fork）                                      │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 仓库布局（新增部分）

```text
WorkflowEvolutionAgent/
  pi/                    # 源码 checkout：只读参考 + 未来上游 PR；运行时不依赖
  runner/                # 新建 TS 包 @wea/runner（L1+L2）
    src/
      run.ts             # CLI 入口：wea run --task ... [--template ...]
      graph.ts           # 图调度核心（移植 scheduler.py 语义）
      node-session.ts    # 节点 ↔ AgentSession 封装（prompt 组装、abort、结果提取）
      recorder-ext.ts    # InlineExtension：采集 tool 事件 + usage
      snapshot.ts        # git snapshot digest / worktree 管理
      budget.ts          # token/$/时间预算记账与执行
      trace-export.ts    # pi 事件 → schemas/trace.schema.json
  library/               # L3：templates/*.json · agents/*.md · index.json（版本化）
  cache/                 # L3：artifact CAS + certificates（gitignore）
  analysis/              # L4：postmortem（调 attribution.py）、distill、gate 脚本
  schemas/ tools/ prototypes/ research/   # 已有资产，不动
```

### 3.2 一次任务的生命周期（数据流）

1. `wea run --task "..."`：构建 TaskCard → 检索或指定模板 → 绑定 slots → 产出不可变 WorkflowInstance（过 `tools/validate_ir.py` 校验后才执行）。
2. runner 按图调度：每个就绪节点先查 exact cache（Phase 4 起）；未命中则 `createAgentSession()`（角色 system prompt、工具白名单、模型、cwd=worktree），注入 recorder，发 task prompt。
3. 节点运行中：recorder 记录 tool 事件与每次 LLM usage；runner 累计预算，超支 `abort()`；写节点的产出留在自己的 worktree。
4. 节点结束：输出 = 最终 assistant 消息（约定 JSON 输出契约）+ write-set 文件 → 存入 CAS，得到 artifact id；下游节点的 prompt 通过引用上游 artifact 组装。
5. fan-in：聚合节点（也是一个 AgentSession 或确定性 merge 脚本）读多个上游 artifact；代码合并走 worktree 三方 merge + 跑测试验证。
6. 结束：runner 图事件 + 各节点 recorder 流合成一份 Trace IR JSONL，`validate_ir.py` 校验入库。
7. 复盘（离线）：`analysis/postmortem` 跑 PVF → 死节点/低 credit/成本报告；meta-agent 读报告出修改提案；人审后模板库出新版本。

---

## 4. 关键设计决策（延续 decision-log 编号）

| ID | 决策 | 理由 | 代价/边界 |
|---|---|---|---|
| D6 | 首个 instrumentation/执行宿主 = **pi**，替代 v0.2 的 OpenHands | TS SDK 进程内全事件流、类型化 tool 拦截、session 树 + 原生 usage、体量小可控、MIT | 放弃 OpenHands 生态与其 SWE-bench 成熟度；后者降级为后续 adapter |
| D7 | 编排用 **SDK 进程内**（AgentSession），不用 RPC 子进程 | 事件零丢失、低开销、单进程易调试；官方也建议 TS 用 SDK | 单机内存上限约束并发节点数；跨机时再启用 RPC/orchestrator 包 |
| D8 | **节点粒度 = 一次 AgentSession run**（不是单个 tool call） | 与 v0.2 "task 级节点"一致；context 隔离天然对齐；成本/归因统计单位稳定 | 节点内部的 tool 循环细节记进 trace 但不作为图节点 |
| D9 | Trace 采集分两层：runner 记图结构，recorder 扩展记节点内部；离线合成已有 `trace.schema.json` | 双层各自最了解自己的事实；转换层薄、可测试 | 先做 node/artifact 级，**不做 v0.2 §16.4 的 ArtifactAtom 级**（主张同步降级，符合红队约束） |
| D10 | `bash` 节点/调用视为 **volatile**：记录但不参与 exact reuse | bash 的实际 read-set 不可观测，复用不 sound（v0.2 §4.6 fail-closed 原则） | 复用命中率降低；只读结构化工具（read/grep/find/ls）先受益 |
| D11 | 写隔离 = **每个写节点独立 git worktree**，fan-in 三方 merge + 测试 | pi 的 `cwd` 参数零成本支持；对齐 SCHED-004 | worktree 创建/清理开销；大 repo 需浅克隆优化 |
| D12 | **不 fork pi**：npm 锁精确版本；需要上游改动时提 PR（其 AGENTS.md 规则严格，PR 面要小） | 跟进上游成本最低；扩展 API 是其公开承诺面，破坏性变更风险低 | 若上游 API 破坏性变更，短期锁旧版顶住 |
| D13 | runner 用 **TypeScript** 重写调度语义；PVF/统计分析保持 **Python** 离线工具 | 调度必须与 SDK 同进程；分析离线跑无互操作压力 | 双语言栈；以 Trace IR JSON 为唯一交接界面，不做进程间耦合 |
| D14 | 节点输出契约：**最终 assistant 消息必须是约定 JSON**（结论/引用/置信度）+ 声明的输出文件 | 下游组装 prompt、CAS 存储、PVF 锚点都需要结构化输出 | 需要角色 prompt 强约束；解析失败按节点失败处理并重试 |

---

## 5. 分阶段实施计划

**策略调整（相对 v0.2 的 M0→M5）**：v0.2 按"论文主张"排序（trace 先行、进化最后）。既然目标改为工程闭环，改用**薄闭环优先**：先用最简形态把六个动词全部串通（复盘先人工在环），再逐段用 v0.2 的设计加固。每阶段沿用 v0.2 的 kill criteria 中适用项。

### Phase 0 — 可行性 spike（约 0.5–1 天）

- 内容：一个 ~200 行脚本：SDK 起 1 个 planner + 2 个并行 worker 节点完成一个玩具任务；订阅事件打印 usage 与 tool 调用；验证 inMemory session、tool 白名单、cwd 指向、abort。
- 验收：并行节点互不串扰；能拿到每节点 token/cost 与全部 tool 事件。
- kill：若 SDK 存在文档未暴露的硬耦合（如必须 TUI 环境），降级用 `--mode rpc` 子进程方案（D7 反转，架构不变）。

### Phase 1 — Runner MVP + Trace 落地（约 1 周）

- 内容：`runner/` 核心（graph.ts 移植 scheduler.py 的 readiness/SEAL 语义的最小子集：ALL_SUCCESS/ANY_SUCCESS + 有界 loop）；人工写 4 个模板（v0.2 §8.5 的 T0 Direct / T1 SafeGeneric / T2 Bugfix / T3 Complex）+ 配套 `agents/*.md`；recorder 扩展；trace-export 合成 Trace IR，过 `validate_ir.py`；`attribution.py` 能对真实 trace 出 PVF 报告。
- 验收（对齐 v0.2 M0）：≥95% 节点有完整 parent/dependency/cost；文件读写归因到节点 ≥90%（bash 除外，单列）；在 2 个真实 repo 任务上端到端跑通 T2/T3。
- 产出数据：开始积累 trace 库（目标先 20–50 条）。

### Phase 2 — 复盘闭环 v0（人工在环，约 3–5 天）

- 内容：`analysis/postmortem`：PVF + 成本汇总 → Markdown 报告（死节点、低 credit 高成本节点、关键路径浪费、重复劳动候选）；meta-agent prompt：读报告 + 模板，输出结构化修改提案（增删节点/改 prompt/换模型/调预算，附理由）；提案经人审后生成模板新版本（immutable，旧版保留）。
- 验收：对同一模板连续 5+ 次运行的复盘能产出至少 1 个被人接受且下次运行可量化改善（token 或时延）的修改。
- 说明：**这一步就是用户愿景里"AI 总结经验、学会怎么分配/怎么写 prompt"的第一次兑现**——只是提案权在 AI、批准权暂在人。

### Phase 3 — 检索与模板复用（约 3–5 天）

- 内容：TaskCard 简化版（goal/task family/repo 语言/可用 oracle）；规则路由 + BM25 检索模板库；slot 绑定与静态校验已由 Phase 1 具备。
- 验收（对齐 v0.2 M3 精简）：slot binding 成功率 ≥98%；检索+填槽在配对任务上不劣于每次冷启动 T1。
- kill：检索无增益 → 保留"手选模板"模式，不阻塞主线。

### Phase 4 — Exact reuse cache（约 1 周）

- 内容：`snapshot.ts`（git HEAD + dirty digest + 工具链指纹）；CAS + reuse certificate（沿用 `schemas/reuse-certificate.schema.json`）；runner spawn 前查表：仅 PURE/READ_ONLY 节点、快照一致、契约一致才命中；singleflight 合并同时在飞的等价节点。
- 验收（对齐 v0.2 M1）：false exact reuse = 0；重复子任务 token 中位数节省 ≥10%（在含并行探索的 T3 类任务上测）。
- kill（对齐 v0.2）：exact duplicate token share < 5% → 缓存降为可选项，主线转 Phase 5。

### Phase 5 — 校准与受控自动化（持续迭代）

- 内容：小规模 LOO 校准（v0.2 §3.4 的分层抽样，首批可缩到 ~30 pairs）；剪枝建议从 dashboard-only 逐级升到 lazy skip（v0.2 §3.5 安全层级）；champion-challenger：新模板版本先 shadow 后小流量，paired 比较（pass/cost/latency），劣化自动回滚；逐步把 Phase 2 的"人审"换成统计门禁 + 抽查。
- 验收（对齐 v0.2 M2/M5 精简）：安全跳过 precision ≥0.8 才允许 lazy skip；champion 晋级必须 quality non-inferior 且 cost/latency 至少一项有置信改善。

---

## 6. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| pi 迭代快，扩展/SDK API 变动 | 中 | npm 锁精确版本；升级走独立 PR + 全量回归；`pi/` checkout 用于 diff 审查 |
| orchestrator 包 experimental，未来可能与我们的 runner 重叠 | 低 | 我们不依赖它；若上游做大，评估把 runner 下沉为其插件或保持平行 |
| bash read-set 不可见导致复用面窄 | 中 | 接受（D10）；中期给 bash 加声明式依赖（模板里写 declared_reads）或沙箱级 fs 追踪 |
| 并行节点烧钱失控 | 中 | budget.ts 硬预算 + 超支 abort 是 Phase 1 必做项，不是可选项 |
| 无权限系统，写节点越权 | 中 | 工具白名单 + worktree 只暴露副本；敏感环境用其 containerization 方案（Gondolin/Docker） |
| meta-agent 提案质量差 / 复盘噪声大 | 中 | 提案永远走版本化 + 门禁，不直接生效；单次异常不允许永久剪枝（v0.2 §3.5 禁令照搬） |
| TS/Python 双栈交接 | 低 | 唯一界面 = Trace IR JSON（已有 schema + validator + 29 个测试守着） |

---

## 7. 已有资产复用清单

| 资产 | 在新架构中的角色 |
|---|---|
| `schemas/*.schema.json`（7 个） | Trace/Template/Instance/Certificate 的数据契约，Phase 1 直接使用 |
| `tools/validate_ir.py` | runner 执行前与 trace 入库前的强制校验闸门 |
| `prototypes/attribution.py`（PVF） | Phase 2 复盘引擎，零改动直接吃新 trace |
| `prototypes/scheduler.py` | Phase 1 graph.ts 的语义参考（不复用代码，复用测试用例思路） |
| `research/reports/01–07` | 各 Phase 的设计输入（复盘→01；复用→02；调度→03；fan-in→04；蒸馏→05；检索→06；gate→07） |
| `examples/valid|invalid/` + `tests/` | 转换层 trace-export 的 conformance 基准 |

---

## 8. 写代码前需最后确认的 pi 细节（Phase 0 清单）

> **状态：已实测回填（2026-07-14）。** 完整证据、数据与 Phase 1 落点见 `spikes/phase0/FINDINGS.md`。
> 一句话：U1–U5 全部通过，Phase 0 kill criteria 未触发，SDK 进程内编排成立，进入 Phase 1。
> 运行前提（实测新增）：pi 依赖 `pi-tui` 用了 `v` regex flag，**要求 Node ≥ 20**（本机默认 Node 18 报 `SyntaxError`；实测用 22.17.0 通过）→ 写入 runner `engines`。

1. **[✅ 定]** SDK 场景 per-session system prompt 通道 → **选定 `DefaultResourceLoader#systemPromptOverride`**（节点级静态角色，开销最低）。`before_agent_start` 返回 `{ systemPrompt }` 作为「按 turn 动态改写」的备用通道。实测：两 worker 严格停在各自角色内，互不串味。
2. **[✅ 定]** `SessionManager.inMemory()` 下 `pi.appendEntry(customType, data)`（**同步方法，在 `pi`/ExtensionAPI 对象上，非 `ctx`**）**可用但不落磁盘**（`persist=false` 时 `_persist` 直接 return）。实测：条目进内存树、带 `id/parentId/timestamp`、可即时 `getEntries()` 读回。→ **recorder 的 trace 必须自带落盘，不依赖 session 文件**；`appendEntry` 仅作会话内 marker。（注：旧 spike 的 `await ctx?.appendEntry?.({...})` 因可选链吞错是**假阳性**，已修。）
3. **[✅ 验（并发2）]** 并行多 `AgentSession` 共享单 `AuthStorage`+`ModelRegistry`：3 distinct session id、usage/read-set 各自独立、wall-clock 证明真并行、无串扰、无限流报错。→ 进程内单例 auth/registry。**高并发 + provider rate-limit 反压未覆盖，留 Phase 1（SCHED-002）。**
4. **[✅ 定]** 节点 JSON 输出契约 → **prompt 强约束 + 最终 assistant 文本解析（剥 fence + `JSON.parse`）即可**，**无需** subagent 示例的子进程 `--mode json`。实测：planner JSON `parseable=true`，keys 齐。软约束 → 解析失败按节点失败重试（D14）。
5. **[✅ 定]** `tool_result` 是否带 read-set digest → **路径维度免费**（`tool_call.input` 强类型带 `path`/`pattern`），**内容 digest 维度 pi 不提供**（所有 `*ToolDetails` 只有 `truncation`/limit，`details=null`；结果只有 `content[]` 文本）。→ **Phase 4 缓存键的 hash 由 runner 自算**，默认对 `tool_result.content` 文本 hash（=模型实际看到的字节，最贴复用语义）。bash 结果无结构化 read-set，印证 D10。
6. **[设计项，非 spike]** `@modelcontextprotocol/sdk` 在 pi 依赖树中仅为 `@google/genai` 的 optional peer dep（pi 核心未直接使用）。MCP bridge（§9）需把它提为**自己的直接依赖**，与 pi 解耦。

**Phase 0 计划外发现（已进 Phase 1 待办，详见 FINDINGS §3）**：
- read-set 路径**不规范化**（相对/绝对/glob 混用）→ runner 自建路径规范化层，且 read（精确读）与 find/grep（负依赖/存在性）分开建模（对齐 v0.2 §4.3）。
- **工具白名单 ≠ 路径隔离**：planner 在只读白名单下仍 `read` 了 `.env`（含 key）→ 敏感文件隔离靠 worktree 副本 + 路径 allowlist；recorder 落 trace 必须对 read-set 做 **redaction**（对齐 SEC-001）。**升为 Phase 1 必做项。**
- 每节点独立 `loader.reload()` 有磁盘发现开销 → Phase 1 评估 loader 骨架复用（优化项，非阻塞）。

---

## 9. MCP-over-Bash Bridge（独立并行子项目 `@wea/mcp-bridge`）

> 状态：设计定稿（2026-07-13）。**独立并行子项目**——不依赖 runner/图调度器，可先行实施、单独产出"实测省 X% token"的早期战果。
> 先例：Anthropic Engineering《[Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)》(2025-11-04，报告某任务 150k→2k token，-98.7%)；Cloudflare 同模式称 "Code Mode"。

### 9.1 动机（根因是 token/上下文成本，不是"MCP 不能和 bash 一起用"）

MCP 直连的两个真正病灶（文章明确列出）：

1. **工具定义预加载**：MCP client 默认把所有工具完整 schema 塞进上下文。几百个工具 = 开口烧几十万 token。
2. **中间结果穿透**：每个工具结果必须完整流经模型上下文；大文档流经两遍（读入 + 写出），2 小时会议转录可多烧 ~50k token，甚至撑爆窗口。

**bridge 之所以有效，根因是 progressive disclosure（按需加载工具定义）+ 结果就地处理**；"用 bash 调用"是实现手段——一旦工具调用变成一条命令，模型就能用它烂熟的 `| grep`、`| jq`、`| head`、`> file.json` **在结果回到上下文前就地过滤**（即"顺便 rg 一下、写进文件里"）。

### 9.2 与本项目的三点协同（是增益，不是附属）

1. **独立于图去重的、纯增量的省 token 来源**，直接叠加到 Claim B 的收益上。
2. **pi 恰好留白且哲学一致**：pi 故意不内置 MCP（`packages/coding-agent/docs/usage.md:307`，连 sub-agent/permission/plan-mode/background-bash 都不做，全推给 extensions）。bridge = 一个 CLI + 一个 pi extension，长在 pi 的纹理上。
3. **顺带解决两个已列难题**：
   - **松动 D10**：裸 bash 的 read-set 不可见故不可复用；但**经 bridge 的 MCP 调用是结构化的**（server + tool + args 全显式），可纳入 read/write-set 与 exact cache。bridge 把一部分原本 volatile 的操作变回可观测、可复用。
   - **落地 SEC-001**：文章的"中间结果默认留在执行环境、PII 自动 tokenize 不进模型"正是我们 schema 的 sensitivity label 想要的执行点。

### 9.3 形态决策（延续 §4 编号）

| ID | 决策 | 理由 |
|---|---|---|
| D15 | 采用**单一 CLI + `search` 子命令**方案（文章 approach B），不用"每工具一文件"的文件树（approach A） | 最贴合"一条可被 bash 调用的命令"；`search` + detail level 直接实现 progressive disclosure；无需预生成文件树或持久沙箱 |
| D16 | **宿主语言 = TypeScript**，与 pi/runner 同栈 | 复用 pi 依赖树里已存在的 `@modelcontextprotocol/sdk`；我们把它提为 `@wea/mcp-bridge` 的**直接依赖**，不碰 pi。对模型对外仍是一条 bash 命令，体验与宿主语言无关 |
| D17 | **独立并行子项目**，不阻塞、不被图调度器阻塞 | 依赖极轻；可在 Phase 0/1 并行；能独立产出"实测省 X% token"的早期战果 |
| D18 | 结果默认**只回摘要/被显式选择的字段**，全量落 `--out <file>` 供 bash 后续处理；敏感字段可 tokenize | 兑现"结果就地处理"与 SEC-001；避免把 bridge 变成又一个上下文黑洞 |

### 9.4 对外命令面（草案）

```bash
# 发现（progressive disclosure：默认只返回 name+desc，--detail full 才给全 schema）
wea-mcp search "salesforce lead"        # 关键词找工具
wea-mcp list [--server gdrive]          # 列服务器/工具
wea-mcp describe gdrive.getDocument     # 单个工具完整 schema

# 调用（结构化参数；结果就地处理）
wea-mcp call gdrive.getDocument --json '{"documentId":"abc123"}' | jq '.content'
wea-mcp call gdrive.getSheet --json '{...}' --out /tmp/rows.json   # 大结果落盘，不进上下文
```

- 配置：读取 `mcp.servers.json`（server 名 → 启动命令/URL + auth），与 pi extension 共享。
- pi extension（`wea-mcp`）：把 CLI 用法作为一段简短说明注入 system prompt（"用 `wea-mcp search` 找工具、`wea-mcp call` 用工具"），并可选把调用记进 Trace IR（结构化 → 可复用）。

### 9.5 里程碑（独立于 Phase 0–5）

- **B0**：CLI 连通 1 个真实 MCP server（如 filesystem 或 github），`search/describe/call` 三命令可用，`--out` 落盘。
- **B1**：pi extension 注入用法；用一个多工具 server 实测**直连 MCP vs 经 bridge 的上下文 token 对比**（复现"定义预加载"与"结果穿透"两项节省）。验收：定义 token 明显下降、大结果不再全量进上下文。
- **B2**：bridge 调用进 Trace IR，接入 exact cache（PURE/READ_ONLY 的 MCP 工具可复用）；tokenize 敏感字段。

### 9.6 边界与风险

- 有副作用的 MCP 工具（写类）与 bash volatile 语义一致，**不参与复用**，只记录（同 D10）。
- `search` 召回质量决定 progressive disclosure 成败；先用 BM25 + server/tool 元数据，与 Phase 3 检索复用同一套。
- MCP server 启动/鉴权失败必须 fail-closed 报错，不静默返回空。

---

## 10. 本文档对既有文档的影响

- `research/worklogs/decision-log.md`：追加 D6–D18（本文 §4、§10.3）。
- `research/OPEN_ISSUES.yaml`：`TRACE-003`（instrumentation adapter 策略）decision 更新为 pi-first；`SCHED-001/REUSE-*` 的 owner 落到 runner/cache 对应 Phase；新增 `MCP-001`（MCP-over-bash bridge，owner = mcp-bridge，P1，independent）。
- `SELF_EVOLVING_AGENT_RESEARCH_PLAN_v0.2.md`：M0 的"OpenHands SDK 首选"表述由本文修订；其余验收/kill criteria 继续有效，按 §5 的映射引用。
