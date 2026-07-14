# WS3：动态 DAG 调度、资源约束、失败恢复与推测执行报告

> 调研日期：2026-07-13  
> 范围：online/incremental scheduler、动态依赖、critical path、API/token/费用限流、speculative execution、retry/idempotency/cancellation、MVP 与评测。  
> 说明：**未修改 `SELF_EVOLVING_AGENT_RESEARCH_PLAN.md`。**

## 一、结论摘要

1. **推荐架构不是“先生成完整 DAG，再拓扑执行”，而是“增量数据流图 + 节点封口协议 + 事件驱动 readiness”。** LLMCompiler 已证明 planner/executor 可以流式重叠，但其公开实现仍以周期扫描判断依赖完成；WS3 的 MVP 应改成完成事件沿邻接表传播，复杂度由反复扫描降为整体近似 \(O(V+E)\)。citeturn630130view0turn113246view0
2. **必须区分 logical readiness 与 resource admission。** 依赖满足只代表节点“可以运行”，不代表在 RPM、TPM、并发槽、费用预算下“现在应该运行”。
3. **动态图中不能允许未封口节点提前执行。** 否则 planner 后续新增入边时，节点可能已经使用了不完整输入。建议引入 `SEAL_NODE`；封口后禁止添加入边，replan 使用新 epoch/version。
4. **critical path 应在线估计，而非追求一次性精确计算。** Teola 使用逆拓扑 depth，Agentix/ATLAS 使用运行中已观察到的最长关键路径；建议组合为“结构 bottom-level + 实测延迟校正 + 未知结构信息价值”。citeturn811150search3turn969440view0
5. **推测执行不能用固定概率阈值。** 正确判据是：命中时节省的关键路径价值，是否大于未命中浪费、配额机会成本、取消成本和副作用风险。
6. **通用 exactly-once execution 不应作为 MVP 承诺。** MVP 应实现：durable at-least-once execution、幂等结果提交、工具级 idempotency key；非幂等且执行结果未知时进入人工/自动 reconciliation，而不是盲目重试。
7. **先做正确性与资源调度，再启用推测执行。** 推测执行是最后一层优化，否则会放大重复副作用、429 和费用失控。

---

## 二、种子文献编号与结论核验

| 来源 | 核验结果 | 与 WS3 直接相关的机制 | 边界与纠正 |
|---|---|---|---|
| **LLMCompiler，arXiv:2312.04511v3，ICML 2024** | 编号、作者和会议均正确。论文为 Sehoon Kim、Suhong Moon 等，ICML 2024/PMLR 235。citeturn630130view0turn320848search0 | Fig.2；§3.2 Task Fetching Unit；§3.3 Executor；§3.4 Dynamic Replanning；§4.2 Streamed Planner。 | 公开实现用约 10ms 周期扫描 remaining tasks，依赖通过 `$id` 占位符解析；没有完整的限流、优先级、retry、cancellation 状态机。citeturn113246view0 |
| **Parrot，arXiv:2405.19888v1，OSDI 2024** | 编号正确；作者为 Chaofan Lin、Zhenhua Han、Chengruidong Zhang 等；MSR/SJTU，正式发表于 OSDI 2024。citeturn538825view0turn773132search1 | §4.2 从 Semantic Variable 恢复请求 DAG；§5.1 ready 后图执行；§5.2 逆拓扑推导 latency/throughput 偏好；§5.4 Algorithm 1 做拓扑、task-group、prefix-sharing 感知调度。 | **Parrot 当前论文并未实现完整动态控制流。** §6 明确把 conditional connection、native function 和高概率分支预启动列为未来扩展，因此不能把它作为“动态分支推测已被验证”的证据。 |
| **SGLang，arXiv:2312.07104v2** | 编号正确；论文标题为 *SGLang: Efficient Execution of Structured Language Model Programs*。citeturn968421view0 | §2 提供异步 stream、`fork/join`；RadixAttention 的 Algorithm 1 是 cache-aware continuous batching；§5 有 API speculative execution。 | §5 的 speculation 是“越过 stop 条件多生成若干 token，并尝试供后续调用复用”，**不是动态 DAG 分支推测**。RadixAttention 调度也主要解决 KV cache/批处理，不是 application-level readiness。 |
| **Teola，arXiv:2407.00326v3** | 已核验预印本版本和主要章节。citeturn811150search3 | §5.1 用 in-degree=0 dispatch；父节点完成后直接递减下游入度；Algorithm 2 使用逆拓扑 depth 做 topology-aware batching。 | Teola 的每请求 e-graph 基本在执行前生成；depth 只是关键路径代理，不考虑节点实际时长，因此不能等价于 weighted critical path。 |
| **Agentix，NSDI 2026** | 已核验 USENIX 正式论文。citeturn197737view0turn969440view0 | 执行 DAG 初始未知、运行中增量构建 IR；Algorithm 1 提出 program-aware scheduling；PLAS 针对单线程，ATLAS 针对动态多线程 DAG，以实测 longest observed critical path 更新优先级。 | 主要调度 LLM inference calls；外部 API 的 RPM/TPM、美元预算和副作用事务仍需 WS3 自行补足。 |
| **LLMSched，arXiv:2504.03444v2** | 论文内容已核验；**正式发表状态未完全核验，按预印本降权使用**。citeturn0view4 | 把 regular、LLM、dynamic stage 放进不确定 DAG；使用信息增益/熵与 SRTF 做 exploration–exploitation。 | 可用于“优先执行能揭示后续结构的节点”这一思路，但不应直接作为生产算法定论。 |

---

# 三、推荐的 online/incremental scheduler 状态机

## 3.1 图级状态

```text
OPEN
  │ 接收 ADD_NODE / ADD_EDGE / SEAL_NODE
  ▼
PLANNER_SEALED
  │ 不再接受当前 epoch 的普通节点；允许 replan 创建新 epoch
  ▼
DRAINING
  │ 所有非终态节点正在执行、重试或取消
  ├──▶ COMPLETED
  ├──▶ FAILED
  └──▶ CANCELLED
```

动态图采用 **epoch 不可变规则**：

- `epoch=k` 中已 `SEALED` 的节点不能再增加入边。
- replanning 不原地修改旧节点，而是创建 `node_id@k+1`。
- 旧 epoch 中尚未运行且已失效的节点标记 `SKIPPED_OBSOLETE`。
- 正在运行的无副作用任务可以取消；已产生外部副作用的任务必须等待确认或执行 compensation。

## 3.2 节点级状态

```text
DECLARED
   │ SEAL_NODE + cycle check
   ▼
WAITING_DEPS ──依赖满足──▶ READY_LOGICAL
                              │
                              │ 资源不足
                              ▼
                         ADMISSION_WAIT
                              │ reserve quota/budget
                              ▼
                           RUNNING
             ┌────────────────┼─────────────────┐
             ▼                ▼                 ▼
         SUCCEEDED       RETRY_WAIT         FAILED_FINAL
                              │
                              └──────────────▶ READY_LOGICAL

任意非终态 ── cancel scope ──▶ CANCELLING ──▶ CANCELLED
未选中的动态分支 ─────────────▶ SKIPPED
```

### 必须保持的四个不变量

1. **未封口节点绝不 dispatch。**
2. **节点封口后禁止新增入边。**
3. **每个 logical node 只有一个 attempt 可以提交最终结果。**
4. **资源 reservation 必须在 dispatch 前完成，在成功、失败、取消后 reconciliation。**

---

# 四、readiness 与动态依赖算法

## 4.1 边类型

建议不要只用简单 predecessor list，而要给边明确语义：

| 边类型 | 满足条件 |
|---|---|
| `DATA_SUCCESS` | producer 成功且输出已物化 |
| `CONTROL_SUCCESS` | producer 成功，不一定传数据 |
| `CONTROL_DONE` | producer 任意终态 |
| `GUARD_TRUE` | 条件表达式解析为真 |
| `OPTIONAL_DATA` | 有结果则注入，无结果使用默认值 |
| `SOFT_HINT` | 不参与 readiness，只影响优先级/缓存 |

节点另带 trigger rule：

- `ALL_SUCCESS`
- `ALL_DONE`
- `ANY_SUCCESS`
- `QUORUM(k)`
- `CUSTOM(predicate)`

## 4.2 readiness 条件

```text
logical_ready(v) =
    v.sealed
    AND v.guard == TRUE
    AND trigger_rule(v) satisfied
    AND all required data inputs materialized
    AND v not cancelled/skipped/terminal
```

**logical ready 不包含资源判断。** 资源允许执行时才进入 `RUNNING`：

```text
dispatchable(v) =
    logical_ready(v)
    AND quota_feasible(v)
    AND concurrency_feasible(v)
    AND budget_feasible(v)
    AND retry_deadline_feasible(v)
```

## 4.3 增量依赖维护

每个节点维护：

```text
required_total
required_satisfied
required_impossible
active_predecessors
consumers[]
sealed
```

事件处理规则：

- `ADD_EDGE(u,v)`：
  1. 必须发生在 `v.sealed == false` 时。
  2. 做 cycle check。
  3. 若 `u` 已成功，边直接为 `SATISFIED`。
  4. 若 `u` 已失败，根据 trigger rule 标记 `IMPOSSIBLE` 或 `SATISFIED_DONE`。
  5. 否则加入 `u.consumers`，递增 `v.required_total`。
- `NODE_SUCCEEDED(u)`：
  - 只遍历 `u.consumers`，更新对应边和下游计数。
  - 某个下游达到 readiness 后压入 ready heap。
- `NODE_FAILED(u)`：
  - 传播失败、允许降级、触发 fallback 或使 quorum 不可达。
- `GUARD_FALSE(v)`：
  - `v -> SKIPPED`，并以“skipped”语义通知下游。
- `SEAL_NODE(v)`：
  - 完成 cycle check 和 unresolved reference 检查，然后才允许 readiness 判断。

### Cycle check

MVP 可采用：

- Planner 输出节点 ID 严格递增，默认只允许指向更早节点，常规边 \(O(1)\) 判定。
- 对 replan、fan-in 或外部插边，运行一次从 `v` 到 `u` 的 DFS/BFS；小图足够。
- 图规模变大后再替换为 incremental topological ordering。

---

# 五、critical path 与资源约束调度

## 5.1 在线 critical-path 估计

Teola 的 depth 简单但不考虑时长；Agentix/ATLAS 能处理未知动态 DAG，但主要依据已执行路径。建议组合：

\[
BL_{95}(v)=Q_{95}(D_v)+\max_{w\in activeChildren(v)}BL_{95}(w)
\]

其中：

- \(D_v\)：节点执行时长分布；
- 对未知后继，加入 `frontier_bonus`；
- 每次新增边、节点完成或 profile 更新时，只重算 dirty ancestors；
- dynamic branch 未决时：
  - SLA 严格：取各分支最大值；
  - 成本优先：取概率加权值；
  - 风险折中：`mean + λ·std`。

可执行节点的建议优先级：

\[
priority(v)=
w_1\frac{1}{slack(v)+\epsilon}
+w_2BL_{95}(v)
+w_3InfoGain(v)
+w_4Age(v)
-w_5ExpectedCost(v)
\]

\[
slack(v)=deadline-now-BL_{95}(v)
\]

`InfoGain` 用于优先执行会揭示大量后续结构的 planner、router、test、condition 节点；这是 LLMSched 思路的轻量版本。citeturn0view4

## 5.2 资源模型

每个 provider/tool 建立多维容量向量：

```text
Capacity:
  request_tokens       # RPM/RPS token bucket
  model_tokens         # TPM token bucket
  concurrent_slots
  tool_specific_slots
  dollar_budget
  cpu/memory/gpu
```

节点资源需求：

```text
Demand(v):
  requests = 1
  tokens = input_tokens + q95(output_tokens)
  expected_cost
  concurrency = 1
  tool/model/provider
```

### Reservation + reconciliation

Dispatch 前：

```text
reserve:
  1 request
  input_tokens + q95(output_tokens)
  q95_expected_cost
  concurrency slot
```

结束后：

```text
reconcile:
  actual request count
  actual input/output tokens
  actual charged cost
  release concurrency slot
```

若实际输出超过 reservation，应立即降低同 provider 后续 admission；若远小于 reservation，返还额度。

## 5.3 调度顺序

推荐两层调度：

1. **跨 workflow/tenant：** weighted fair queue，避免大 DAG 垄断。
2. **workflow 内部：** 最小 slack / 最大 criticality 优先。
3. **资源放置：** 在满足 provider/model/tool 约束的执行器中，选择预计完成时间最早者。
4. **speculation 单独使用低优先级预算池。**

建议预留：

```text
critical_reserved_capacity = 70%~90%
speculative_capacity       = 0%~20%
background_capacity        = remaining
```

比例应由负载动态调整；高负载、429 增多或 deadline miss 时，将 speculative capacity 降为 0。

---

# 六、speculative execution 的期望收益判据

## 6.1 证据边界

- SGLang 的 API speculation 是跨 stop 条件的额外生成复用，不是 DAG branch speculation。citeturn968421view0
- Parrot 和 Agentix 都把高概率分支预启动/branch prediction 列为可扩展方向或未来工作，而非已经充分验证的完整算法。citeturn773132search1turn969440view0
- 因此下面是 **[设计推导]**，不能写成已有论文已证明结论。

## 6.2 单分支判据

定义：

- \(p_j\)：分支 \(j\) 最终被选择的概率；
- \(B_j\)：命中时减少的 critical-path latency 所对应的价值；
- \(W_j\)：未命中时已经消耗的 token、费用和工具资源；
- \(O_j\)：占用 RPM/TPM/并发槽导致的机会成本，以及取消开销；
- \(R_j\)：副作用、数据过期、结果污染风险。

\[
EV_j=p_jB_j-(1-p_j)W_j-O_j-R_j
\]

仅当：

\[
EV_j>0
\]

才允许启动。

若忽略风险，等价概率阈值为：

\[
p_j>\frac{W_j+O_j}{B_j+W_j}
\]

其中延迟收益可估为：

\[
B_j=Value_{latency}\cdot
E[\min(T_{decision},T_j)]
\]

含义：分支任务最多只能隐藏“等待分支决策的时间”和“自身运行时间”中的较小值。

## 6.3 启用条件

仅在以下条件同时满足时推测：

- 节点是 `PURE`、read-only，或运行在 sandbox。
- 有可靠的分支概率，并做过 calibration。
- 当前 speculative budget 足够。
- 不会挤占负 slack 的 critical nodes。
- 任务支持快速 cooperative cancellation。
- 输入不会在分支确定前发生语义变化。

禁止推测：

- 发邮件、付款、提交代码、创建资源等非幂等操作。
- provider 已接近 RPM/TPM 上限。
- 结果依赖尚未稳定。
- branch probability 不可校准。
- 取消后仍会计费完整执行的大型外部任务。

多个互斥分支应视为 knapsack：在 speculative token/$ budget 内选择总 \(EV\) 最大的 top-k，而不是全部预跑。

---

# 七、retry、idempotency 与 cancellation

## 7.1 工具语义标注

每个节点必须声明：

```text
effect_class:
  PURE
  IDEMPOTENT
  IDEMPOTENT_WITH_KEY
  COMPENSATABLE
  NON_IDEMPOTENT

retry_class:
  NEVER
  TRANSIENT_ONLY
  SAFE
```

## 7.2 Idempotency key

推荐：

```text
idempotency_key =
  hash(workflow_id,
       logical_node_id,
       input_content_digest,
       effect_epoch)
```

结果表采用 CAS：

```text
logical node:
  PENDING -> COMMITTED(result, winning_attempt_id)
```

后到达的 hedge/retry 结果不得再次发布。

但要注意：

- 本地结果 ledger 只能保证“调度器只采用一个结果”。
- 外部副作用是否只发生一次，仍依赖目标 API 支持 idempotency key、事务或可查询的 operation ID。
- 非幂等调用超时且无法确认是否成功时，应进入 `UNKNOWN_EFFECT/RECONCILIATION`，不能盲重试。

## 7.3 Retry 分类

| 错误类型 | 策略 |
|---|---|
| 429 / 暂时性 5xx / 网络未连接成功 | respect retry-after；指数退避 + full jitter |
| 连接断开且无法确认服务端是否执行 | 仅幂等或有 idempotency key 时自动重试 |
| 参数错误、权限错误、确定性解析错误 | 不自动重试；触发 repair/replan |
| LLM 格式错误 | 可使用更严格 schema/prompt 做有限次数 repair |
| 预算不足、deadline 已不可达 | 直接终止或降级模型/工具 |
| 非幂等副作用结果未知 | reconciliation 或人工确认 |

Retry 必须同时受以下约束：

```text
attempt < max_attempts
now + backoff + expected_duration < deadline
remaining_retry_budget >= estimated_cost
workflow not cancelled
```

## 7.4 Cancellation

采用 scope-based cancellation：

- 取消 workflow → 递归取消所有非终态节点。
- 取消分支 → 仅取消该 branch scope。
- pending/ready 节点立即标记 `CANCELLED`。
- running 节点发送 cooperative cancel。
- 若底层不支持取消，则递增 `attempt_generation`；迟到结果因 generation 不匹配被丢弃。
- 已提交副作用不能伪装成取消成功，应执行 compensation 或报告 `CANCELLED_WITH_EFFECT`。

---

# 八、MVP 核心伪代码

```python
enum NodeState:
    DECLARED, WAITING_DEPS, READY, ADMISSION_WAIT
    RUNNING, RETRY_WAIT, CANCELLING
    SUCCEEDED, FAILED, CANCELLED, SKIPPED

class Node:
    id
    epoch
    sealed = False
    state = DECLARED
    trigger_rule = ALL_SUCCESS
    incoming = []
    consumers = []
    required_total = 0
    required_satisfied = 0
    impossible = 0
    attempt = 0
    attempt_generation = 0
    profile                 # latency/token/cost distribution
    effect_class
    deadline
    speculation = False

def add_edge(parent, child, edge_type, guard=None):
    assert not child.sealed
    assert not creates_cycle(parent, child)

    edge = Edge(parent, child, edge_type, guard)
    child.incoming.append(edge)
    parent.consumers.append(edge)

    if edge_is_already_satisfied(parent, edge):
        child.required_satisfied += 1
    elif edge_is_impossible(parent, edge):
        child.impossible += 1
    elif edge_is_required(edge):
        child.required_total += 1

def seal_node(node):
    resolve_pending_references(node)
    assert not has_cycle(node)
    node.sealed = True
    refresh_readiness(node)

def refresh_readiness(node):
    if node.state in TERMINAL:
        return

    if trigger_impossible(node):
        node.state = SKIPPED if node.has_fallback else FAILED
        propagate_terminal(node)
        return

    if (
        node.sealed
        and trigger_satisfied(node)
        and required_inputs_materialized(node)
    ):
        node.state = READY
        ready_heap.push(node, priority(node))
    else:
        node.state = WAITING_DEPS

def on_parent_terminal(parent):
    for edge in parent.consumers:
        child = edge.child

        if edge_satisfied(parent, edge):
            child.required_satisfied += 1
        elif edge_impossible(parent, edge):
            child.impossible += 1

        refresh_readiness(child)

def priority(node):
    return (
        deadline_urgency(node)
        + CP_WEIGHT * bottom_level_p95(node)
        + INFO_WEIGHT * information_gain(node)
        + AGE_WEIGHT * waiting_time(node)
        - COST_WEIGHT * expected_cost(node)
    )

async def scheduler_loop():
    while graph_not_terminal():
        await wait_for_event_or_timer()

        refill_rate_limit_buckets()
        release_expired_reservations()
        recompute_dirty_critical_paths()

        candidates = fair_select_across_workflows(ready_heap)

        for node in candidates:
            if not resource_manager.feasible(node):
                node.state = ADMISSION_WAIT
                continue

            reservation = resource_manager.reserve(node)
            node.state = RUNNING
            node.attempt += 1
            node.attempt_generation += 1

            spawn(execute_attempt(
                node,
                node.attempt_generation,
                reservation
            ))

        maybe_launch_positive_ev_speculations()

async def execute_attempt(node, generation, reservation):
    try:
        result, usage = await invoke_tool(
            idempotency_key=make_idempotency_key(node)
        )

        resource_manager.reconcile(reservation, usage)

        if generation != node.attempt_generation:
            discard_late_result(result)
            return

        if result_ledger.commit_once(node.id, result):
            node.state = SUCCEEDED
            cancel_losing_hedges(node)
            on_parent_terminal(node)

    except Exception as error:
        resource_manager.reconcile_failure(reservation, error)

        if node_is_cancelled(node):
            node.state = CANCELLED
            on_parent_terminal(node)

        elif retryable(error, node) and retry_budget_feasible(node):
            node.state = RETRY_WAIT
            delay = retry_after_or_exponential_jitter(error, node.attempt)
            schedule_timer(delay, lambda: requeue(node))

        elif effect_outcome_unknown(error, node):
            node.state = FAILED
            create_reconciliation_record(node, error)
            on_parent_terminal(node)

        else:
            node.state = FAILED
            on_parent_terminal(node)

def maybe_launch_positive_ev_speculations():
    headroom = resource_manager.speculative_headroom()
    if headroom <= 0:
        return

    candidates = [
        n for n in unresolved_branch_candidates()
        if n.effect_class == PURE and expected_value(n) > 0
    ]

    for node in solve_budgeted_top_k(candidates, headroom):
        node.speculation = True
        ready_heap.push(node, low_priority_speculative_rank(node))
```

---

# 九、评测方案

## 9.1 正确性与合成 DAG

构造可重复 simulator：

- chain、wide map、diamond、fan-in、fork-join。
- 动态 if/else、router 运行后生成子图。
- 递归 expansion、replan epoch。
- `ALL_SUCCESS`、`ALL_DONE`、`ANY_SUCCESS`、quorum。
- 非法 late edge、cycle、missing dependency。
- duration 使用 log-normal/Pareto，制造长尾。
- failure rate：0%、1%、5%、20%。
- branch entropy、概率校准误差。
- output-token 估计误差：±10%、±50%、重尾。
- RPM/TPM burst 和 429 注入。
- cancel race、timeout-after-side-effect、late result。

## 9.2 真实工作负载

1. LLMCompiler 的 HotpotQA、Movie Recommendation、ParallelQA、Game of 24、WebShop，用于 planner/executor overlap 和动态 replanning。citeturn630130view0
2. Parrot 风格的 map-reduce/chain document processing 和 multi-agent code/test workflow。citeturn773132search1
3. SGLang 风格的 branch-solve-merge、ReAct、Tree-of-Thought、多轮调用。citeturn968421view0
4. Coding-agent workload：从 SWE-bench 类任务采集真实 tool/sub-agent trace，再进行 deterministic replay。

## 9.3 Baseline

- Sequential/ReAct。
- Full-plan + static topological FCFS。
- LLMCompiler-like greedy polling。
- Teola-like depth priority。
- Critical-path only。
- Critical-path + rate/token/cost admission。
- 完整方案：CP + resource + retry + speculation。
- 小图使用 clairvoyant CP-SAT/oracle 作为上界。

## 9.4 指标

### 性能

- E2E latency：p50/p95/p99。
- makespan。
- planner/executor overlap。
- critical-path stretch：

\[
stretch=\frac{actual\ makespan}{clairvoyant\ lower\ bound}
\]

- throughput、executor utilization、queue time。

### 成本与配额

- input/output token。
- 美元费用。
- 429/限流次数。
- reservation error。
- 每个成功任务的 token/$。

### 推测执行

- speculation hit rate。
- 命中时 latency saved。
- wasted token/$。
- cancellation latency。
- `net EV`。
- speculation 对非推测关键节点的 slowdown。

### 可靠性

- workflow completion rate。
- retry amplification。
- duplicate external effects。
- late-result leak。
- cancellation 后仍提交的节点数。
- reconciliation 数量。
- scheduler event-processing overhead。

### 公平性

- tenant/workflow slowdown。
- Jain fairness index。
- 长任务 starvation 时间。

## 9.5 必做 ablation

- 去掉 `SEAL_NODE`。
- 事件驱动改成周期扫描。
- mean token reservation vs q95 reservation。
- FCFS vs depth vs weighted critical path。
- 去掉 aging/fairness。
- 去掉 information-gain priority。
- 固定 speculation probability vs EV criterion。
- 无 idempotency ledger。
- 无 speculative capacity 隔离。

## 9.6 MVP 验收门槛建议

- 任意故障注入下：**0 个未满足依赖即执行的节点**。
- cycle/late edge 全部被拒绝或版本化。
- 幂等测试中：**0 个重复 committed result**。
- 非幂等 unknown-effect 场景：**0 次盲重试**。
- deterministic quota simulator 中：不主动超发 RPM/TPM。
- 动态/宽 DAG 相比 static FCFS：p95 latency 至少下降 10%，且 token/$ 增幅不超过 3%。
- speculation 必须满足正 net utility；高负载下自动退化为无 speculation。
- scheduler 开销目标：低于 E2E 时间的 1%，或每个图事件低于约 1ms——这是工程目标，需实测调整。

---

# 十、建议的实施顺序

1. **MVP-0：** 增量图、`SEAL_NODE`、事件驱动依赖计数、cycle check。
2. **MVP-1：** 并发槽 + RPM/TPM token bucket + token/$ reservation。
3. **MVP-2：** weighted critical path、deadline slack、workflow fairness。
4. **MVP-3：** retry policy、result ledger、idempotency key、cancel scope。
5. **MVP-4：** 仅对 pure/read-only 节点启用 EV-based speculation。
6. **MVP-5：** duration/token/branch probability 在线学习和 calibration。

---

## 十一、仍未完全解决的问题

- **动态分支 speculation 缺少直接、充分的 agent-workflow 实证。** Parrot 与 Agentix 都主要把它作为后续优化方向，因此收益判据必须通过本项目实验验证。
- **输出 token 和工具时长分布可能高度漂移。** q95 reservation 需要在线校准，否则会过度保守或频繁超额。
- **第三方工具的 exactly-once effect 无法由调度器单方面保证。**
- **跨 provider 的美元价值、latency SLA 与 token quota 如何统一成 shadow price**，需要结合实际部署目标标定。
- **LLMSched 的正式发表状态未完全核验**，当前只作为不确定性调度的启发，不作为核心正确性依据。
