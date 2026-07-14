# Decision Log

> Topic: 基于图结构 Workflow IR 的自进化 Coding Agent
> Start date: 2026-07-13

## Decisions

| Date | ID | Type | Decision | Rationale | Evidence refs | Impact | Follow-ups |
|---|---|---|---|---|---|---|---|
| 2026-07-13 | D1 | Reframe | 将项目拆成“可观测、可安全复用、可受控改进”三个独立可证伪主张 | 原计划一次跨 WS0–WS8，范围过大且关键假设耦合 | initial audit | v0 先不做在线自改 | 每阶段设置 kill criteria |
| 2026-07-13 | D2 | Scope | single-trace 方法称为 attribution proxy，不直接称因果 credit | 真正边际贡献需要反事实；避免过度主张 | H1,H2 | 设计中加入 LOO 校准 | 等 agent A |
| 2026-07-13 | D3 | Safety | exact reuse 默认开启；semantic/adapt reuse 默认关闭或必须经风险闸门 | silent contamination 是最高风险 | H3,H4,C3 | MVP 优先 correctness | 等 agent B |
| 2026-07-13 | D4 | Architecture | 先设计三层 IR，但要求 canonical executable source 与派生 views 单向一致 | 避免三个真相源漂移 | H5,H6 | schema 中声明 source-of-truth | 等 agent E |
| 2026-07-13 | D5 | Evaluation | 自采 trace benchmark 作为 v0 必做，不等待公共数据集 | 无数据无法验证任何优化 | H12 | instrumentation 提至第一优先级 | 制定采样协议 |
| 2026-07-13 | D6 | Platform | 首个 instrumentation/执行宿主 = pi（earendil-works/pi-mono），替代 v0.2 M0 的 OpenHands | TS SDK 进程内全事件流、类型化 tool 拦截、session 树+原生 usage、体量小、MIT | PI_INTEGRATION_PLAN §0/§1 | OpenHands/SWE-agent 降级为后续 adapter | Phase 0 spike 验证 |
| 2026-07-13 | D7 | Architecture | 编排用 pi SDK 进程内 AgentSession，不用 RPC 子进程 | 事件零丢失、低开销；官方建议 TS 用 SDK | PI_INTEGRATION_PLAN §4 | 跨机再启用 RPC/orchestrator | spike 验证并发行为 |
| 2026-07-13 | D8 | Model | 节点粒度 = 一次 AgentSession run | 与 task 级节点一致；context 隔离对齐；统计单位稳定 | PI_INTEGRATION_PLAN §4 | 节点内 tool 循环记 trace 不作图节点 | — |
| 2026-07-13 | D9 | Trace | 双层采集：runner 记图结构 + recorder 扩展记节点内部，合成 trace.schema.json；先 node/artifact 级不做 atom 级 | 各层记自己最了解的事实；符合红队降级约束 | PI_INTEGRATION_PLAN §4 | 论文主张同步降级 | — |
| 2026-07-13 | D10 | Safety | bash 视为 volatile：记录但不参与 exact reuse | read-set 不可观测，复用不 sound（fail-closed） | v0.2 §4.6 | 复用面缩小到结构化只读工具 | bridge（D15+）可部分松动 |
| 2026-07-13 | D11 | Safety | 写隔离 = 每写节点独立 git worktree，fan-in 三方 merge+测试 | pi cwd 参数零成本支持；对齐 SCHED-004 | PI_INTEGRATION_PLAN §4 | 大 repo 需浅克隆优化 | — |
| 2026-07-13 | D12 | Platform | 不 fork pi：npm 锁精确版本，必要时上游小 PR | 跟进上游成本最低；扩展 API 是公开承诺面 | PI_INTEGRATION_PLAN §4 | 破坏性变更时锁旧版 | — |
| 2026-07-13 | D13 | Stack | runner 用 TS 重写调度语义；PVF/统计保持 Python 离线 | 调度须与 SDK 同进程；分析离线无互操作压力 | PI_INTEGRATION_PLAN §4 | 双语言栈，以 Trace IR JSON 为唯一界面 | — |
| 2026-07-13 | D14 | Contract | 节点输出 = 约定 JSON 的最终 assistant 消息 + 声明输出文件 | 下游 prompt 组装/CAS/PVF 锚点都需结构化 | PI_INTEGRATION_PLAN §4 | 解析失败按节点失败重试 | spike 验证 JSON 输出机制 |
| 2026-07-13 | D15 | MCP | MCP bridge 采用单一 CLI + search 子命令（非每工具一文件） | 贴合 bash 调用；search+detail level 即 progressive disclosure | Anthropic code-execution-with-mcp | 无需文件树/持久沙箱 | B0 实现 |
| 2026-07-13 | D16 | MCP | bridge 宿主语言 = TypeScript，@modelcontextprotocol/sdk 提为直接依赖 | 与 pi/runner 同栈；对模型仍是一条 bash 命令 | PI_INTEGRATION_PLAN §9 | 不碰 pi | — |
| 2026-07-13 | D17 | Scope | MCP bridge 为独立并行子项目，不阻塞图调度主线 | 依赖极轻；可先产出省 token 战果 | PI_INTEGRATION_PLAN §9 | — | B1 做 token 对比实测 |
| 2026-07-13 | D18 | MCP | bridge 结果默认只回摘要/选定字段，全量落 --out 文件；敏感字段可 tokenize | 结果就地处理 + SEC-001 | PI_INTEGRATION_PLAN §9 | — | B2 接 Trace IR/cache |
| 2026-07-14 | D19 | Platform | per-node system prompt 通道固化为 `DefaultResourceLoader#systemPromptOverride`；`before_agent_start` 返回 `{systemPrompt}` 仅作按-turn 动态备用 | Phase 0 实测两 worker 角色零串味；loader 通道最简、开销最低 | spikes/phase0/FINDINGS §2-U1 | node-session.ts 一节点一 loader；评估 loader 骨架复用 | Phase 1 实现 |
| 2026-07-14 | D20 | Trace | recorder 的 trace 持久化完全自有（sink→runner 写 JSONL），不依赖 pi session 文件；`pi.appendEntry` 仅作会话内 marker | inMemory 下 appendEntry 进内存树但不落盘（`_persist` 早退）；旧 spike 假阳性已修 | FINDINGS §2-U2 | 细化 D9 的采集层实现 | recorder-ext.ts |
| 2026-07-14 | D21 | Contract | 节点 JSON 输出 = 进程内 prompt 强约束 + 最终 assistant 文本解析（剥 fence + JSON.parse），不用子进程 `--mode json` | Phase 0 实测 parseable=true；子进程通道与 D7 冲突且事件有损 | FINDINGS §2-U4 | 细化 D14；解析成功率进 Phase 1 指标 | node-session.ts 重试兜底 |
| 2026-07-14 | D22 | Reuse | read-set 内容 digest 由 runner 对 `tool_result.content` 文本自算；pi 不提供任何 digest（*ToolDetails 仅 truncation） | hash「模型实际看到的字节」最贴复用语义；重读文件有 TOCTOU 风险 | FINDINGS §2-U5 | Phase 4 缓存键形态确定为 path+self-hash | recorder 采 content hash |
| 2026-07-14 | D23 | Safety | 路径规范化 + redaction 升为 Phase 1 必做：read-set 统一 resolve；read（精确）与 find/grep（存在性/负依赖）分开建模；trace 落盘前对敏感路径（.env 等）redact | 实测 read-set 相对/绝对/glob 混用；只读白名单下 planner 读到了 .env——工具白名单≠路径隔离 | FINDINGS §3.1/3.2 | 对齐 v0.2 §4.3 负依赖与 SEC-001 | trace-export.ts + recorder |
| 2026-07-14 | D24 | Trace | trace-export 产出**双 trace 面**：`wea.trace/v1`（合规，过 validate_ir.py）+ `wea.pvf.trace/v1`（归因输入），同一 RunManifest 派生 | attribution.py 实际消费自有 `wea.pvf.trace/v1`（occurrences/relations/anchors），**不直接吃** `wea.trace/v1`——§7"零改动直接吃新 trace"须经投影层成立；投影是确定性纯函数（executedPredecessors/criticalPath/anchors） | runner/src/trace-export.ts；两真实 run 验证 VALID+PVF 合理 | PVF 语义（derive/validate/verdict→utility）固化在投影层，Phase 2 复盘直接复用 | rebuild.ts 支持离线重投影 |
| 2026-07-14 | D25 | Postmortem | 浪费识别不靠 attribution.py 的绝对 `low_credit`（阈值0，成功 run 上从不触发），而靠**同 trace 内相对信号**：credit/token 分位排序（low_efficiency）+ 同 role 近等 credit 检测（redundancy）+ dead + critical-path waste | 实测成功 run 的 low_credit 恒为空；真实 T3 里两 explorer credit 完全相等（0.0761278…）是对称冗余教科书信号，靠相对排序才抓得到 | analysis/postmortem.py；3 条真实/合成 trace 各抓到可执行杠杆 | meta-agent 消费 finding.kind+prune_safe | 阈值参数 LOW_EFFICIENCY_* 待 LOO 校准 |
| 2026-07-14 | D26 | Safety | ~~自进化安全=提案端确定性禁令（拒删 protected 角色/拒仅凭低credit删/须finding指名）~~ **被 D28 推翻** | — | — | 见 D28 | — |
| 2026-07-14 | D28 | Philosophy | **信任 AI：安全从提案端搬到结果端。** meta-agent 可任意重设计（删 verifier、加节点、改模型、重构全图，wea.proposal/v2 开放编辑词汇 remove/add_node·edit_prompt·set_model·add/remove_edge·set/remove_loop）。gate 只验**结构可执行性**（边指向真实端点、@input→@output 可达、无非法环、无孤儿），不做任何意图/安全审查——"跑不起来"是语法问题，与信任无关。安全完全靠 champion gate：新版本=challenger，只有赢下配对评测才取代 champion，输了回滚，旧版永不销毁。**权力来自赢得测量，不来自被许可。** | 用户明确指令"相信 AI 的思想是好的、不会恶意操作，只保证语法对"；禁止式安全假设 AI 更笨且与 v0.2 §9 champion-gate 主张矛盾；为将来更强的 AI 设计 | 8/8 gate 单测：删verify+重接线/塌缩单节点/换模型/加verifier 全 RUNNABLE，仅悬空边/孤儿/断路 BLOCKED | champion gate 成为唯一强制门（依赖端点稳定跑 A/B）；per-node model 已接线（GraphNode.model→node-session） | 唯一保留的物理护栏：试跑不可有不可逆外部副作用（靠 worktree/沙箱，非限制 AI 判断） |
| 2026-07-14 | D27 | Evolution | 改进必须**配对 A/B 中位数**证明，非单 run：非劣化（候选 pass≥基线）+ 成本/token 至少一项置信改善；新版本写 `<id>@<ver>.json`，旧版不篡改 | 单 trace 弱证据（v0.2 §11.3）；实测单次 A/B 撞上一次 JSON 重试就把 token 口径污染（+64% token 但 −10% cost），必须多对取中位数 | analysis/ab_compare.py；meta-agent 真实产出 t3-complex@1.0.1（删 explore_b） | 对齐 Phase 5 champion-challenger | immutable archive 雏形 |
