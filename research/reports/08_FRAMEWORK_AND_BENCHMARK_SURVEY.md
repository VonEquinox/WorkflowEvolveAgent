# 并行攻关 H：Framework Instrumentation 与 Benchmark 轨迹审计

> **核验日期：2026-07-13**  
> **证据范围：**只使用各项目官方文档、官方仓库和官方论文/benchmark 仓库。  
> **代码快照：**OpenHands SDK `c5379ec`、OpenHands `3949e1c`、SWE-agent `1132b3e`、Aider `5dc9490`、LangGraph `55ec2f2`、AutoGen `027ecf0`、CrewAI `fb8e93b`、DSPy `6f1e17e`、MetaGPT `11cdf46`、SWE-bench `f7bbbb2`、SWE-bench/experiments `2f15350`。  
> **评级：**`A`=原生结构化接口足以无损导出；`B`=核心信息存在，但需 wrapper/推断；`C`=主要依赖日志或侵入式 patch；`—`=官方能力中未发现。

# 一、框架对照表

## 1.1 调用结构、边界 Hook 与调用级观测

| 框架 | 调用结构：tree / graph / loop | sub-agent 边界 Hook | LLM / tool span 或等价事件 | token / cost | 结论 |
|---|---|---|---|---|---|
| **OpenHands Software Agent SDK** | Agent 主循环基于 append-only event stream；事件可组成 tree；`DelegateTool` 创建嵌套子 agent / child conversation | **原生强**：delegation action/observation、父子 conversation、event subscriber、server hook/webhook | **原生强**：LLM completion log、message、action、observation、hook、state update 均为可序列化事件；可接 observability backend | **原生强**：每次及累计 prompt/completion/cache token、累计美元 cost | **A，首选**。结构、coding 工具、持久化和 benchmark 适配同时具备。官方：[Events](https://docs.openhands.dev/sdk/guides/observability/events)、[Delegation](https://docs.openhands.dev/sdk/guides/agent-delegation)、[Metrics](https://docs.openhands.dev/sdk/guides/observability/metrics)、[SDK source](https://github.com/OpenHands/software-agent-sdk/tree/c5379ec) |
| **SWE-agent** | 单 Agent ↔ SWEEnv 的显式 step loop；`.traj` 保存 `query/response/thought/action/observation/state` | **无一等 sub-agent**；有 run/agent hooks，可截获 step 生命周期 | step 级记录完整，但不是统一 span tree；tool 主要表现为 shell/action 与 observation | **原生** ModelStats/trajectory 可保留 token、API call、cost | **B**。非常适合线性 coding-agent baseline，不适合验证多 agent 图归因。官方：[Trajectories](https://swe-agent.com/latest/usage/trajectories/)、[Architecture](https://swe-agent.com/latest/background/architecture/)、[hooks/replay source](https://github.com/SWE-agent/SWE-agent/tree/1132b3e/sweagent/run) |
| **Aider** | 交互式 edit loop；architect mode 是 architect→editor 两次模型调用；lint/test 可触发修复循环 | **无通用 sub-agent 边界**；architect/editor 只能作为两个 LLM scope 适配 | 无原生统一 trace API；可从内部调用、analytics、chat history、git diff/commit 包装 | 有调用 token/cost 报告与 provider usage；粒度依赖模型接口 | **B-**。文件结果强，执行结构弱；适合作为“git-centric 单 agent”对照。官方：[Modes](https://aider.chat/docs/usage/modes.html)、[Git](https://aider.chat/docs/git.html)、[Caching](https://aider.chat/docs/usage/caching.html)、[Analytics](https://aider.chat/docs/more/analytics.html) |
| **LangGraph** | **原生 graph/subgraph/branch/loop**；节点、task、subgraph namespace 明确 | **原生强**：subgraph、task、stream event、callback/trace 上下文 | **原生强**：stream modes 可发 tasks/custom/messages；LangSmith tracing 可覆盖 graph/node/LLM/tool | 模型 usage 可由消息/callback/LangSmith 获取；美元 cost 依赖 provider/价格映射 | **A（图语义）/B（coding artifact）**。最适合作为第二个跨框架 adapter，但本身不规定文件系统 provenance。官方：[Streaming](https://docs.langchain.com/oss/python/langgraph/streaming)、[Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)、[Observability](https://docs.langchain.com/oss/python/langgraph/observability) |
| **AutoGen** | AgentChat teams；`GraphFlow` 支持 sequential/parallel/conditional/loop，但官方仍标为 experimental | Agent/message/topic/runtime 边界原生存在；Core runtime 可插 logging、intervention 和 telemetry | **原生** event logging 与 OpenTelemetry tracing；AgentChat 有 tool request/execution、stream chunk 等事件 | `RequestUsage` 原生记录 prompt/completion tokens；美元 cost 需外部价格映射 | **B+**。能力完整，但截至 2026-07-13 官方仓库已进入 maintenance mode，不应作为首个长期集成目标。官方：[GraphFlow](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html)、[Telemetry](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/telemetry.html)、[maintenance notice](https://github.com/microsoft/autogen/tree/027ecf0) |
| **CrewAI** | Crew 支持 sequential/hierarchical；Flow 支持 start/listen/router、分支与循环 | **原生强**：全局 event bus 覆盖 crew/flow/agent/task/tool 生命周期 | **原生强**：event listeners、内置 tracing listener 和企业 trace；tool start/finish/error 事件明确 | `UsageMetrics` 原生记录 prompt/completion/cached/reasoning/cache-creation tokens；统一美元 cost 较弱 | **A-/B+**。当前 hooks 与 checkpoint 很强，但 coding 文件语义仍取决于所用 tool。官方：[Event listener source](https://github.com/crewAIInc/crewAI/blob/fb8e93b/docs/v1.14.4/en/concepts/event-listener.mdx)、[Flows](https://github.com/crewAIInc/crewAI/blob/fb8e93b/docs/v1.14.4/en/concepts/flows.mdx) |
| **DSPy** | Python `Module`/`Predict` 嵌套调用；loop/branch 是宿主 Python 控制流，不是权威图 IR | 没有 agent 概念；但 `BaseCallback` 覆盖 module、LM、adapter、tool start/end，并带 call id | callback 足以构造调用树；官方 observability 主要通过 callback/MLflow 等集成 | `UsageTracker` 聚合 provider usage/token；统一美元 cost 非核心字段 | **B-**。适合导出 program/LM/tool call tree，不适合作为多 agent workflow benchmark 首选。官方：[callback source](https://github.com/stanfordnlp/dspy/blob/6f1e17e/dspy/utils/callback.py)、[usage source](https://github.com/stanfordnlp/dspy/blob/6f1e17e/dspy/utils/usage_tracker.py) |
| **MetaGPT** | Role–Action–Environment 消息驱动 SOP；Role 有 react loop，Team 协调多角色 | Role/Action/Message 是显式边界，但缺少统一、稳定的外部 event subscriber/span contract | 主要依赖日志、Role/Action 包装和 Environment message interception | `CostManager` 原生维护 prompt/completion token 与总 cost | **C+/B-**。组织结构可见，但要得到无损 Trace IR 需要侵入 Role、Action、Environment 和 workspace 层。官方：[Team](https://github.com/FoundationAgents/MetaGPT/blob/11cdf46/metagpt/team.py)、[Role](https://github.com/FoundationAgents/MetaGPT/blob/11cdf46/metagpt/roles/role.py)、[CostManager](https://github.com/FoundationAgents/MetaGPT/blob/11cdf46/metagpt/utils/cost_manager.py) |

## 1.2 Artifact、恢复、缓存与 Trace IR 可导出性

| 框架 | artifact / file read-write | checkpoint / replay | result cache / KV-prefix cache | 导出本项目 Trace IR | 主要缺口 |
|---|---|---|---|---|---|
| **OpenHands SDK** | FileEditor/ApplyPatch/Terminal 等 action-observation 可精确记录显式编辑；可对 workspace 做前后快照。**任意 shell 子进程的隐式 read-set 仍需 syscall/tool wrapper** | event store、持久化 conversation、resume；支持从历史点恢复/分支，事件 sourcing 便于 replay | 支持静态上下文/provider prompt cache 观测；有内部 view/file cache；**没有通用 workflow-result cache** | **A**：Conversation→Run；delegation→SPAWN；LLM/tool→Attempt；file event→Artifact/DependencyObservation | 需要补 shell/network/环境依赖捕获，防止把“命令输出”误当完整 read-set |
| **SWE-agent** | trajectory 含 shell action/observation、环境 state、最终 patch；文件读写需解析命令，覆盖不完备 | 官方 run-replay 可重放历史 action，并可用保存 config 重跑；不是任意时点的完整环境 checkpoint | 未发现通用 result/KV cache | **B**：线性 attempt 很容易；graph、artifact provenance 较弱 | 无 sub-agent lineage；命令级隐式读写与副作用不完整 |
| **Aider** | **写入强**：Git diff、自动 commit、`/undo`；读入上下文可从 in-chat files/repo map 推断，但无完整读取事件 | Git commit 是工作区回滚点；chat history 可持久化/恢复；非确定性 execution replay 不完整 | provider prompt caching；无 workflow result cache | **B-** | 缺标准事件总线、父子 scope、tool span；repo-map 被使用不等于每个文件被因果消费 |
| **LangGraph** | State/artifact 引用可作为 channel；具体文件/命令/network 由节点/tool adapter 自行记录 | **强**：checkpointer、durable execution、time travel、fork/replay | **原生 node/task cache**；KV/prefix cache 仍是模型 provider 层 | **A（控制图）/B（完整执行事实）** | 框架不知道节点内部读了哪些文件、产生了哪些外部副作用 |
| **AutoGen** | tool/code executor 事件可见；文件 provenance 取决于 executor/workbench | Agent/team `save_state/load_state`；可恢复消息与 agent state，但外部环境未必可重放 | **原生 `ChatCompletionCache`**；KV cache 非统一能力 | **B+** | GraphFlow experimental；外部工具和文件 read-set 不完备；项目进入维护模式 |
| **CrewAI** | task output、tool input/output、flow state 可记录；文件读写依赖具体 tool | **强但 early release**：Crew/Flow/Agent checkpoint、restore、fork；另有 task replay | 默认 tool cache/缓存 token 统计；无通用 graph-node result cache | **B+** | checkpoint API 尚可能变化；artifact schema 和文件依赖不是框架统一语义 |
| **DSPy** | Prediction/Module/Tool I/O 可记录；没有 workspace/file 一等实体 | Program/module save/load；不是执行中环境 checkpoint/replay | **原生 LM memory+disk response cache**；不是 workflow artifact cache | **B-** | Python 控制流不显式；无 agent lineage、workspace snapshot、side-effect contract |
| **MetaGPT** | 软件环境会生成文档/代码；可拦截 Message 与 repository 写入，但无统一 artifact event schema | Team `serialize/deserialize` 与 recovery utility 可恢复部分项目状态 | 有零散 response/experience cache；无统一 result/KV cache contract | **C+** | trace hook、schema 稳定性、工具/文件级 lineage 和 replay 完备性不足 |

# 二、首选 Instrumentation Target

## 明确建议

**第一优先：instrument `OpenHands Software Agent SDK`，并以 SWE-bench Lite/Verified 作为 outcome oracle。**不要先改 legacy OpenHands monolith；adapter 应尽量只依赖 SDK 的公开 Event/Conversation/Tool 接口。

### 选择理由

1. **与研究目标同域**：它直接执行真实 coding-agent 工作负载，不需要把通用编排框架再改造成代码 agent。
2. **唯一同时具备的组合**：append-only event sourcing、显式 agent loop、可序列化 LLM/tool events、token/cost、文件编辑工具、持久化、resume/branch、原生 delegation/subagent。
3. **最小侵入即可得到高价值 trace**：订阅事件流 + 包装 ToolExecutor + workspace snapshotter，不必重写 scheduler 或 agent policy。
4. **能立即制造两种对照数据**：
   - 单 agent OpenHands：作为线性/loop baseline；
   - 开启 DelegateTool 的 OpenHands：产生真实父子 agent tree，可测试 graph reconstruction、credit assignment 和冗余检测。
5. **比其他候选更适合作为第一站**：
   - LangGraph 的图语义最好，但没有标准 coding workspace/file provenance；
   - SWE-agent 轨迹干净，但没有一等 sub-agent graph；
   - CrewAI hooks 很强，但 coding artifact 语义依赖自选工具；
   - AutoGen 已进入 maintenance mode；
   - Aider/DSPy/MetaGPT 都需要更侵入的边界重建。

### 第一阶段采集边界

```text
OpenHands Conversation/EventStore
  ├─ root conversation                   → ExecutionRun
  ├─ delegated child conversation        → Agent NodeAttempt + SPAWN edge
  ├─ LLMCompletionLog / metrics delta    → MODEL_CALL NodeAttempt
  ├─ Action + Observation                → TOOL_CALL NodeAttempt
  ├─ FileEditor / ApplyPatch              → Artifact read/write + pre/post digest
  ├─ Terminal command                     → PROCESS_EXEC + stdout/stderr artifact
  ├─ StatsUpdate                          → token/cost ledger
  ├─ persistence cursor / snapshot        → CHECKPOINT
  └─ resume / fork                        → REPLAY_OF / BRANCH_FROM edge
```

### 必须补的 wrapper

- `TerminalTool`：记录 cwd、argv、exit code、stdout/stderr digest、wall time；可选 syscall/dep-file 捕获真正 read-set。
- workspace：每个 tool/agent scope 前后生成 Merkle snapshot，归因 changed files；未观测到的修改标记 `undeclared_write`。
- network/MCP/browser：记录 endpoint/service、request/response digest、freshness；默认不保存 secret/raw credential。
- benchmark runner：将 `instance_id`、base commit、test patch、evaluation report 与 trace run_id 绑定。

**第二优先才是 LangGraph adapter**：用来验证同一 Trace IR 是否能覆盖显式 DAG/subgraph/loop，而不是用它生成第一批 coding benchmark 数据。

# 三、Adapter Contract

## 3.1 框架无关接口

```python
class TraceAdapterV1(Protocol):
    def identity(self) -> "AdapterIdentity": ...
    def capabilities(self) -> "AdapterCapabilities": ...

    async def attach(
        self,
        framework_run: object,
        sink: "TraceSink",
        policy: "CapturePolicy",
    ) -> "AdapterSession": ...

    def normalize(
        self,
        raw_event: object,
        session: "AdapterSession",
    ) -> list["NormalizedTraceEvent"]: ...

    async def snapshot_artifact(
        self,
        locator: "ArtifactLocator",
        session: "AdapterSession",
    ) -> "ArtifactRef": ...

    async def finalize(
        self,
        session: "AdapterSession",
        outcome: object,
    ) -> "ExecutionRun": ...
```

## 3.2 必须输出的统一事件

```yaml
NormalizedTraceEvent:
  schema: wea.trace-event/v1
  event_id: digest                 # 幂等去重
  run_id: uuid
  sequence: integer                # 同一 run 内稳定顺序
  observed_at: timestamp

  scope:
    scope_id: string
    parent_scope_id: string?
    kind: RUN | AGENT | MODEL_CALL | TOOL_CALL | VALIDATOR | CHECKPOINT
    logical_node_id: string?
    attempt_no: integer
    agent_id: string?

  event_type:
    RUN_START | RUN_END |
    SCOPE_START | SCOPE_END |
    MESSAGE | SPAWN |
    MODEL_REQUEST | MODEL_RESPONSE |
    TOOL_REQUEST | TOOL_RESULT |
    ARTIFACT_READ | ARTIFACT_WRITE |
    PROCESS_EXEC | NETWORK_IO |
    STATE_UPDATE | CHECKPOINT |
    CACHE_LOOKUP | CACHE_HIT | CACHE_MISS |
    ERROR | CANCEL

  timing:
    start_ns: integer?
    end_ns: integer?

  usage:
    input_tokens: integer?
    output_tokens: integer?
    cached_input_tokens: integer?
    reasoning_tokens: integer?
    monetary_cost: decimal?
    provider_reported: boolean

  artifact_refs: [digest]
  dependency_refs: [digest]
  status: STARTED | SUCCEEDED | FAILED | CANCELLED | UNKNOWN

  provenance:
    framework: string
    framework_version: string
    source_commit: string?
    raw_event_type: string
    raw_event_id: string?
    raw_blob_digest: digest
    evidence_level: OBSERVED | WRAPPED | INFERRED
```

## 3.3 归并到现有 Trace IR 的规则

| 统一事件 | Trace IR 落点 |
|---|---|
| `RUN_START/RUN_END` | `ExecutionRun` |
| `AGENT/MODEL_CALL/TOOL_CALL/VALIDATOR` scope | `NodeAttempt`；不得把一个 agent 的多轮调用压成单个 LLM span |
| `SPAWN` | `EdgeSpec(type=SPAWN)`，保存 parent/child scope |
| 消息被具体下游消费 | `DATA_DEP` + `ArtifactBinding`；仅“出现在 prompt 中”时标记 `presented`，不得直接标记 `used` |
| `ARTIFACT_READ/WRITE` | `Artifact` + `DependencyObservation`；含 path、pre/post digest、scope 与 capture method |
| `PROCESS_EXEC` | tool attempt + stdout/stderr artifact + environment dependency |
| `CHECKPOINT` | checkpoint artifact；resume 产生 `REPLAY_OF`，fork 产生 `BRANCH_FROM` |
| `CACHE_*` | `NodeAttempt.cache_decision`；必须区分 prompt/KV cache、LM response cache、tool cache、workflow-result cache |
| token/cost delta | `NodeAttempt.cost`；同时保留 provider raw usage，禁止只存 run total |

## 3.4 强制语义

1. **原始事件不可丢**：Normalized event 必须指向 immutable raw blob；adapter 升级后可重放重新规范化。
2. **观测与推断分离**：解析 shell 字符串猜测文件读取只能标 `INFERRED`；不能冒充完整 `DependencyObservation`。
3. **父子边必须稳定**：sub-agent、subgraph、task、LLM、tool 各有独立 scope id；异步事件通过 links 连接，不能强塞成单父 span。
4. **文件完整性优先于正文存储**：默认保存 digest、size、classification、受保护 CAS ref；prompt、源码、stdout 受 redaction/ACL 控制。
5. **缓存类型不可混淆**：provider prompt/KV hit 不等于 workflow result reuse；两者必须使用不同 `cache_kind`。
6. **恢复不等于确定性 replay**：checkpoint 还原了框架 state，但若 repo、network、model revision 未冻结，`replay_fidelity` 必须标为 `PARTIAL`。
7. **完整度显式化**：每次 run 输出：

```yaml
completeness:
  agent_lineage: COMPLETE | PARTIAL | UNKNOWN
  llm_calls: COMPLETE | PARTIAL | UNKNOWN
  tool_calls: COMPLETE | PARTIAL | UNKNOWN
  file_writes: COMPLETE | PARTIAL | UNKNOWN
  file_reads: COMPLETE | CONSERVATIVE | INCOMPLETE | UNKNOWN
  network_inputs: COMPLETE | PARTIAL | UNKNOWN
  token_cost: PROVIDER_REPORTED | ESTIMATED | MISSING
```

# 四、Benchmark / 公开 Trace 数据缺口

## 4.1 SWE-bench 官方 experiments/trajs 的实际覆盖

对官方 [`SWE-bench/experiments@2f15350`](https://github.com/SWE-bench/experiments/tree/2f15350) 的本地审计结果：

- `evaluation/**/metadata.yaml` 共 **317** 份；
- 其中 **255** 份声明了 `assets.trajs` S3 URI；**58** 份明确为 `trajs: null`；**4** 份未给 trajectory 字段；
- **281** 份声明了 logs URI，**36** 份缺失或为空；
- Git 仓库本身主要保存 submission metadata、README 和汇总 results；大体积 logs/trajs 位于外部 S3。官方 README 明确要求配置 AWS 账户/CLI 才能下载；`.traj` 并不是一个跨 submission 的统一 schema。

因此，原计划中“完全没有公开轨迹”需要修正为：

> **已有大量可下载的公开 reasoning trajectories，但它们覆盖不完整、格式不统一，也缺少本项目所需的执行图、逐节点资源和 artifact provenance；不能直接当作 Trace IR benchmark。**

## 4.2 关键缺口

| 缺口 | 当前公开数据通常有什么 | 本项目仍缺什么 |
|---|---|---|
| **统一 schema** | submission 自定义 `.traj`、日志、README | versioned、machine-checkable Trace IR；统一 event/type/edge vocabulary |
| **sub-agent 图** | 多数只有线性对话或 reasoning/action 序列 | parent/child agent id、SPAWN/JOIN/FEEDBACK、并发和 message-consumer edges |
| **逐节点 token/cost/latency** | 有的提供 run total，有的在文本日志中，有的完全缺失 | 每个 agent/LLM/tool attempt 的 provider-reported usage、cost、start/end、critical-path 信息 |
| **artifact provenance** | 最终 patch、评测日志、偶尔有 tool output | 每次文件 read/write、pre/post digest、stdout/stderr、generated artifact、consumer 关系 |
| **依赖完整性** | shell 命令或最终 diff | repo snapshot、read-set、negative dependencies、环境变量、toolchain、network freshness |
| **checkpoint/replay** | 偶尔有对话重放或配置 | checkpoint lineage、resume/fork、replay fidelity、外部副作用处理 |
| **cache 观测** | 偶尔有 cached token 总数 | prompt/KV、LM response、tool result、workflow result 四类 cache decision 的逐调用记录 |
| **attempt lineage** | metadata 常写 `attempts: 1` 或 `2+` | 每次 attempt 的完整 trace、候选选择规则、失败 attempt、最终采用哪个 patch |
| **版本与可复现性** | model 名、系统链接、粗粒度 metadata | exact repo commit、agent commit、prompt/tool/config digest、provider model revision、container/toolchain digest |
| **数据可用性** | S3 URI 和下载脚本 | 内容 manifest、对象 checksum、长期版本固定、无需账户的稳定镜像、缺失文件清单 |
| **评价信号** | resolved/unresolved、测试日志、patch stats | 节点级 credit label、真实 removal/LOO、错误分类、verifier coverage、人工质量标签 |
| **跨框架可比性** | 各提交按自己的 trace 粒度发布 | 同一任务、相同预算、统一采集策略下的 OpenHands/SWE-agent/Aider/其他框架 paired runs |

## 4.3 最小可用的新 benchmark 产物

每个 SWE-bench instance 至少发布：

```text
run_manifest.json
raw_events.jsonl.zst
trace_ir.jsonl.zst
artifacts.manifest.json
workspace_before.merkle
workspace_after.merkle
patch.diff
usage_by_attempt.json
checkpoints.manifest.json
cache_decisions.jsonl
benchmark_outcome.json
```

并满足：

- 单 agent 与 delegated multi-agent 两套预算匹配运行；
- 成功、失败、timeout、budget stop 均保留；
- 原始事件与 normalized Trace IR 都有 schema/version/content digest；
- 最终 evaluator logs 与 agent execution logs 分离；
- file-read 捕获不完整时必须明确标 `INCOMPLETE`，不得静默当作完整 provenance；
- 至少抽取一小批节点做真实 LOO/replay 校准，才能支持后续 credit assignment 与结构剪枝研究。

**结论：SWE-bench 继续作为最终 outcome oracle；第一批 Trace IR benchmark 应由 OpenHands SDK 自采，而不是等待官方 experiments/trajs 自然变成统一的多 agent 执行图数据集。**
