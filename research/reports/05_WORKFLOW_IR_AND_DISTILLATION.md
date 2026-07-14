# WS6：Workflow IR 表示、模板蒸馏与版本化库——收敛报告

> **研究日期：2026-07-13**  
> **执行方式：**7 条并行子任务，分别核验 AWM、ADAS、ExpeL/Voyager、GPTSwarm，并独立完成 IR Schema、子图蒸馏和反方审查。  
> **文件状态：**未修改原始文档 `/Users/vonequinox/Program/GithubProjects/WorkflowEvolutionAgent/SELF_EVOLVING_AGENT_RESEARCH_PLAN.md`。

---

## 一、最终明确选型

### 推荐：**Graph-centered 三层混合 IR，但只有一个权威源**

```text
NL 语义/检索视图
        ↑ 派生
参数化 WorkflowTemplate（typed graph，库中权威表示）
        ↓ 绑定 slots
WorkflowInstance（本次执行的不可变权威表示）
        ↓ 编译
runtime plan + code/tool/model/prompt artifacts
        ↓
execution trace graph
```

具体规则：

1. **库中的权威表示：参数化、带类型和 effect 的声明式图 `WorkflowTemplate`。**
2. **运行时权威表示：完成槽位绑定、默认值展开、artifact 解析后的不可变 `WorkflowInstance`。**
3. **Code 不与 graph 并列成为第二份真相：**
   - code、tool、prompt、model 是节点引用的、内容寻址的执行 artifact；
   - 编译产物可以是 Python/TypeScript，但它是派生物，不能反向覆盖模板。
4. **NL routine 不控制拓扑：**
   - 用于 summary、检索、解释、适用范围和失败案例；
   - 但行为相关的 prompt 必须作为带 digest 的 artifact 版本化，不能仅视为普通说明文字。
5. **保留 code-native fallback：**
   - 任意动态生成节点、复杂异常处理、无法声明副作用的开放式 workflow，先放在 `experimental/code-native`；
   - 只能生成 derived trace graph，不自动晋级为稳定图模板。

因此，不推荐：

- 纯 NL routine；
- 纯 Python code archive；
- 裸拓扑图；
- NL/code/graph 三份可独立编辑的“平权三层 IR”。

推荐的准确表述是：

> **Graph IR 是可编辑、可归因、可参数化和可版本化的控制/数据契约；code/tool/model/prompt 是被图引用的不可变执行 artifact；NL 和结构 embedding 是派生的检索视图。**

---

## 二、五项一手来源核验结论

| 工作 | 实际保存/优化的表示 | 对 WS6 的有效启示 | 不能证明什么 |
|---|---|---|---|
| **AWM** | 文本化 workflow description，加上线性环境状态、推理和 action steps；通过占位符抽象任务值，再作为 prompt memory 使用 | NL abstraction 和相似任务检索确实能提升 workflow 复用 | 没有 typed signature、显式数据依赖、控制流、绑定验证、版本或迁移机制，不能单独作为精确 IR | 
| **ADAS** | Meta Agent 生成完整 Python `forward()`；archive 追加保存名称、设计思路、代码、代数和 fitness | Code 是强表达、可执行的 agent 设计搜索空间 | 代码依赖外部框架；archive 不是 portable IR，也没有图规范化、effect contract 和生产晋级机制 |
| **ExpeL** | 保存成功/失败轨迹；把经验抽象为 NL insights，通过 ADD/EDIT/UPVOTE/DOWNVOTE 更新；另检索相似成功轨迹 | “可执行模板”之外还需要经验规则、失败禁忌和检索 memory | Insight 是 advice，不是精确 workflow；无法替代执行 IR |
| **Voyager** | 经过执行和 self-verification 的 JavaScript skills；根据自动生成的描述建向量索引并检索复用 | 可执行 skill、描述索引、验证后入库是非常直接的先例 | 参数类型和版本机制较弱；同名 skill 的 active entry 会被覆盖；强依赖 Mineflayer/Minecraft runtime |
| **GPTSwarm** | operation 为节点、信息流为边的 DAG；通过 REINFORCE 优化跨 agent 边，并优化节点 prompt | 图天然适合拓扑优化、剪枝和归因 | 论文聚焦 DAG 和以字符串为主的 I/O；节点语义仍在 Python 类和 prompt 中，并不是完整的 portable schema |

AWM 的正式版本发表于 ICML 2025，其论文和官方实现都把 workflow 用作从经验中抽取并加入 agent memory 的可复用 routine。citeturn102306search0turn102306search2

ADAS 的 ICLR 2025 论文明确把整个 agentic system 放在 code search space 中，并由 Meta Agent Search 迭代生成新 agent。citeturn947741search0turn947741search2

ExpeL 在 AAAI 2024 发表，其核心是从成功/失败经验中抽取自然语言 insight，并检索历史成功轨迹。citeturn947741search1

Voyager 将经过验证的可执行程序放入不断增长的 skill library，并通过技能描述进行检索和组合。citeturn392343search0turn392343search1turn392343search2

GPTSwarm 在 ICML 2024 将 agent 表示为 DAG computational graph，并分别对边连接和节点 prompt 进行优化。citeturn947741search3

### 综合判断

这五项工作不是互斥路线，而是分别证明了三种信息都需要：

- AWM/ExpeL：**语义抽象和经验检索**；
- ADAS/Voyager：**可执行 artifact**；
- GPTSwarm：**显式拓扑及其优化**。

但没有一项工作提供了“typed graph + executable artifact + retrieval metadata + lifecycle/versioning”的完整库，因此该组合仍是本项目可主打的系统设计。

---

## 三、四种 IR 方案比较

| 维度 | NL routine | Code-as-IR | Graph-only | 推荐混合方案 |
|---|---:|---:|---:|---:|
| 可直接执行 | 低 | **高** | 中 | **高** |
| 精确 diff/patch | 低 | 高 | 高 | **高** |
| 显式拓扑、并行、归因 | 低 | 低—中 | **高** | **高** |
| 参数类型与静态校验 | 低 | 中 | 高 | **高** |
| 动态控制表达能力 | 中，靠 LLM | **高** | 中 | 高，受限图 + code fallback |
| 检索和跨任务语义泛化 | **高** | 低—中 | 中 | **高** |
| frequent subgraph mining | 低 | 低 | **高** | **高** |
| 副作用与权限审计 | 低 | 中 | 中 | **高，前提是 effect schema** |
| 版本、迁移、回滚 | 低 | 高 | 高 | **高** |
| 多份表示漂移风险 | — | — | — | 低，前提是单一权威源 |

### 为什么不直接选择 Code-as-IR

Code 在表达能力上最强，但会带来：

- 语法差异掩盖结构等价；
- 很难稳定挖掘 frequent subgraph；
- 控制依赖、数据依赖、副作用和并行关系可能被隐藏；
- 对某个 agent framework、SDK、语言版本高度耦合；
- “生成的代码可运行”不等于“可安全检索、参数化和迁移”。

### 为什么不能采用裸 Graph

图只描述节点和边仍然不够。每个节点必须同时具有：

- typed input/output ports；
- operator/code/tool/prompt/model artifact 引用；
- effect 和 permission；
- retry/timeout/cache/idempotency；
- guard/join/loop 语义；
- provenance 和适用范围。

---

## 四、推荐 Schema

### 4.1 核心对象

建议定义三个对象：

| 对象 | 作用 |
|---|---|
| `WorkflowTemplate` | 参数化模板，存储在库中，拥有 template SemVer |
| `WorkflowInstance` | 模板绑定 task inputs/slots 后的不可变执行图 |
| `RunRecord` | 实际 runtime、模型、工具版本、输出、成本、trace 和评价 |

### 4.2 `WorkflowTemplate` 必备字段

```text
schema_version
kind
metadata
requires
spec.interface
spec.slots
spec.artifacts
spec.nodes
spec.edges
spec.control
spec.constraints
spec.provenance
spec.evaluation
```

节点最少需要：

```text
id / kind / op_ref
typed inputs / outputs
artifact refs
config / prompt bindings
effects / permissions
timeout / retry / cache / idempotency
guard / activation policy
```

边最少需要：

```text
from node.output
to node.input
kind: data | control | feedback
optional
transform_ref
```

### 4.3 槽位 Schema

每个 slot 必须显式声明：

```yaml
slots:
  test_command:
    type: string
    required: true
    binding_time: compile
    source: task_or_infer
    constraints:
      min_length: 1
    sensitivity: internal

  target_files:
    type: list[path]
    binding_time: runtime
    source: locate.files
    constraints:
      min_items: 1
      max_items: 20
      path_scope: workspace
```

建议支持三种绑定时间：

- `retrieval`：影响模板是否适用；
- `compile`：执行前必须完成，如语言、测试命令、模型策略；
- `runtime`：由上游节点输出产生。

MVP 只允许：

- scalar；
- enum；
- path/artifact ref；
- typed list/map；
- derived expression。

暂不允许任意 YAML 片段或任意子图作为 slot，避免模板变成不可分析的宏系统。

---

## 五、Canonicalization 与稳定身份

### 5.1 两种 digest 必须分开

#### `spec_digest`：执行身份

包含：

- 绑定后的节点、边和 ports；
- artifact digests；
- retry、cache、loop、guard、effect、权限策略；
- 所有行为相关 prompt；
- compile-time slots。

用于：

- exact execution；
- cache key；
- replay；
- provenance。

#### `shape_digest`：检索/挖掘身份

会进行：

- 节点 ID alpha-renaming；
- 文件名、symbol、repo、具体模型等替换为 typed slots；
- operator patch version 可按兼容规则折叠；
- commutative join 的输入排序；
- 删除时间戳、token、run UUID 等 trace 属性。

`shape_digest` **禁止**用作执行缓存或结果复用。

### 5.2 规范化步骤

1. YAML 只接受 JSON-compatible 子集；
2. 拒绝 duplicate keys、anchors、custom tags；
3. 展开默认值和 artifact alias；
4. 校验所有 port 类型及 effect；
5. 对 DAG 做稳定拓扑排序；
6. 对等价 slot 做 alpha-renaming；
7. 对 commutative join 输入按子图 hash 排序；
8. 生成确定性 JSON；
9. 计算 SHA-256。

确定性 JSON 可直接采用 RFC 8785 的 JSON Canonicalization Scheme，而不应自行定义完整 YAML canonicalization。citeturn366027search2

---

## 六、MVP 可执行格式示例

以下是压缩后的 `bugfix-basic` 模板。Artifact digest 为示例值；实际执行时必须由 registry 提供真实 artifact。

```yaml
schema_version: 0.1.0
kind: WorkflowTemplate

metadata:
  namespace: core
  name: bugfix-basic
  template_version: 0.1.0
  summary: "检索→定位→并行基线测试/审查→patch→验证"
  lifecycle: candidate

requires:
  runtime: ">=0.1.0 <0.2.0"
  capabilities: [typed-ports@1, dataflow@1, snapshot-workspace@1]

spec:
  interface:
    inputs:
      issue: {type: wir/Issue@1, required: true}
      repo: {type: wir/WorkspaceSnapshot@1, required: true}
    outputs:
      patch: {type: wir/PatchSet@1}
      verification: {type: wir/TestReport@1}

  slots:
    max_files:
      type: integer
      default: 12
      binding_time: compile
      constraints: {minimum: 1, maximum: 30}

    test_command:
      type: string
      required: true
      binding_time: compile
      source: task_or_infer

  artifacts:
    repo_search:
      kind: tool
      uri: mcp://repo/search@1
      digest: sha256:1111111111111111111111111111111111111111111111111111111111111111

    coder:
      kind: model-policy
      uri: model-policy://coding/strong@1
      digest: sha256:2222222222222222222222222222222222222222222222222222222222222222

    locate_prompt:
      kind: prompt
      uri: prompt://bugfix/locate@1
      digest: sha256:3333333333333333333333333333333333333333333333333333333333333333

    patch_prompt:
      kind: prompt
      uri: prompt://bugfix/patch@1
      digest: sha256:4444444444444444444444444444444444444444444444444444444444444444

    test_runner:
      kind: code
      uri: registry://workflow/test-runner@1
      digest: sha256:5555555555555555555555555555555555555555555555555555555555555555
      entrypoint: test_runner:run

  nodes:
    retrieve:
      kind: tool
      op_ref: repo.search@1
      artifact_ref: repo_search
      inputs:
        issue: wir/Issue@1
        repo: wir/WorkspaceSnapshot@1
      outputs:
        candidates: wir/FileCandidates@1
      config:
        max_results: "${slot.max_files}"
      effects: [workspace.read]
      policy: {timeout_ms: 30000, retry: 2, cache: exact}

    locate:
      kind: agent
      op_ref: llm.structured@1
      model_ref: coder
      prompt_ref: locate_prompt
      inputs:
        issue: wir/Issue@1
        candidates: wir/FileCandidates@1
      outputs:
        diagnosis: wir/Diagnosis@1
        files: wir/FileSet@1
      effects: [model.invoke, workspace.read]

    baseline:
      kind: code
      op_ref: code.invoke@1
      artifact_ref: test_runner
      inputs:
        repo: wir/WorkspaceSnapshot@1
        files: wir/FileSet@1
      outputs:
        report: wir/TestReport@1
      config:
        command: "${slot.test_command}"
        mode: baseline
      effects: [workspace.read, process.exec]

    review:
      kind: agent
      op_ref: llm.review@1
      model_ref: coder
      inputs:
        issue: wir/Issue@1
        diagnosis: wir/Diagnosis@1
        files: wir/FileSet@1
      outputs:
        report: wir/ReviewReport@1
      effects: [model.invoke, workspace.read]

    patch:
      kind: agent
      op_ref: llm.patch@1
      model_ref: coder
      prompt_ref: patch_prompt
      inputs:
        repo: wir/WorkspaceSnapshot@1
        diagnosis: wir/Diagnosis@1
        baseline: wir/TestReport@1
        review: wir/ReviewReport@1
      outputs:
        patched_repo: wir/WorkspaceSnapshot@1
        patch: wir/PatchSet@1
      effects: [model.invoke, workspace.snapshot.write]
      policy: {retry: 1, cache: disabled}

    verify:
      kind: code
      op_ref: code.invoke@1
      artifact_ref: test_runner
      inputs:
        repo: wir/WorkspaceSnapshot@1
      outputs:
        report: wir/TestReport@1
      config:
        command: "${slot.test_command}"
        mode: full
      effects: [workspace.read, process.exec]

  edges:
    - {from: "@input.issue",       to: retrieve.issue}
    - {from: "@input.repo",        to: retrieve.repo}
    - {from: "@input.issue",       to: locate.issue}
    - {from: retrieve.candidates,  to: locate.candidates}
    - {from: "@input.repo",        to: baseline.repo}
    - {from: locate.files,         to: baseline.files}
    - {from: "@input.issue",       to: review.issue}
    - {from: locate.diagnosis,     to: review.diagnosis}
    - {from: locate.files,         to: review.files}
    - {from: "@input.repo",        to: patch.repo}
    - {from: locate.diagnosis,     to: patch.diagnosis}
    - {from: baseline.report,      to: patch.baseline}
    - {from: review.report,        to: patch.review}
    - {from: patch.patched_repo,   to: verify.repo}
    - {from: patch.patch,          to: "@output.patch"}
    - {from: verify.report,        to: "@output.verification"}

  control:
    scheduler: dataflow
    activation: all_required_inputs
    max_parallelism: 4
    failure_mode: fail_fast
    budgets:
      wall_time_ms: 1200000
      model_tokens: 120000
    loops: []

  constraints:
    - require-pinned-execution-artifacts
    - no-shared-mutable-workspace
    - writes-produce-new-snapshot

  evaluation:
    gates:
      - source: verify.report
        assertion: "value.passed == true"
```

运行绑定：

```yaml
template: core/bugfix-basic@0.1.0

inputs:
  issue:
    id: ISSUE-123
    text: "修复空配置导致 parser 崩溃"
  repo:
    uri: workspace://snapshot/repo-before-fix

slots:
  test_command: "pytest -q"
  max_files: 10
```

`baseline` 与 `review` 会在 `locate` 后并行；`patch` 是隐式 all-input join；写入产生新的 workspace snapshot，避免两个并行节点共享可变目录。

---

## 七、Frequent/High-value Subgraph Distillation

### 7.1 核心原则

不能直接做：

```text
成功 trace → 普通 frequent subgraph mining → 高频模式入库
```

因为存在：

- 同一任务多次 retry 导致 support inflation；
- 常见日志/读取/test boilerplate 高频但可能无价值；
- 只看成功轨迹会产生幸存者偏差；
- 模式与成功相关不等于模式导致成功；
- 文件名、symbol、prompt 等高基数属性会把同一结构切碎；
- 稀有但高价值的恢复/验证子图会被最低支持度过滤掉。

gSpan 提供 canonical DFS code、right-most extension 和基于 transaction support 的结构搜索基础，但原始算法需要扩展到 directed、typed、attributed execution graph。citeturn366027search0

### 7.2 推荐三通道发现

#### A. Frequent lane

发现高覆盖结构骨架：

- directed typed gSpan；
- 3–10 节点、最多 12 条边；
- support 按独立 `root_task_cluster` 计算；
- 保存 closed patterns，避免相同支持集的冗余子图爆炸。

#### B. Utility/discriminative lane

从以下 anchor 向外受限扩展：

- 高 WS5 credit 节点；
- patch producer；
- verifier/test/judge；
- 高 token/latency 节点；
- failure recovery；
- 成功/失败 matched pair 中差异显著的节点。

允许较低 support，但只能进入 incubator/shadow。

#### C. Episode lane

发现非连续但有偏序关系的 routine，例如：

```text
search → inspect definition → edit → targeted test
```

即使中间穿插日志、预算检查或读取无关文件，也能被识别。

### 7.3 Candidate 必须满足的结构条件

- connected；
- 边方向和 port type 匹配；
- 边界输入/输出全部显式；
- 无隐藏外部状态；
- 子图在 DAG 中应尽量是 convex region：路径离开后不得重新进入；
- side effects 必须完整声明；
- 任意环在 trace 中先展开为 occurrence DAG；
- 稳定模板中的循环重新压缩为带 `max_iterations` 和 termination predicate 的结构化 loop。

---

## 八、模板槽位推断

对同一 pattern 的多次 occurrence 做结构对齐和 typed anti-unification。

### 推断规则

1. 跨 occurrence 基本不变，且不是 repo/task 特有标识：
   - 保留固定值。
2. 值变化但类型和语义角色一致：
   - 推断为 input slot。
3. 值由内部稳定节点产生：
   - 推断为 derived slot。
4. 两个字段始终相等或存在稳定变换：
   - 合并为同一 slot，或定义派生表达式。
5. secret、token、绝对路径、用户数据：
   - 强制 slot 化并标记 sensitivity。
6. 无法从执行前输入或内部 producer 获得：
   - 视为 unstable attribute，拒绝自动模板化。

```python
def infer_attribute(values, availability):
    values = normalize(values)

    if consistency(values) >= 0.95 and not task_specific(values):
        return FixedValue(mode(values))

    typ = least_common_supertype(values)

    if availability == "before_execution":
        return InputSlot(
            type=typ,
            constraints=infer_constraints(values)
        )

    producer = find_stable_internal_producer(values)
    if producer:
        return DerivedSlot(type=typ, producer=producer)

    return RejectAsUnstable()
```

MVP 暂不自动推断：

- 任意可选大子图；
- 任意循环体；
- 任意 prompt rewrite；
- 无法声明 effect 的代码块。

---

## 九、完整蒸馏伪代码

```python
def distill_workflow_templates(raw_traces, cfg):
    # 必须在发现 pattern 前切分，防止同 repo/同任务泄漏。
    discovery, tuning, locked_holdout = grouped_temporal_split(
        raw_traces,
        group_key=("repo", "task_family", "root_task_cluster"),
        ratios=(0.60, 0.20, 0.20),
    )

    graphs = [
        normalize_to_occurrence_dag(
            trace,
            strip_runtime_noise=True,
            keep_typed_ports=True,
            keep_effects=True,
            forbid_outcome_in_labels=True,
        )
        for trace in discovery
    ]

    tx_db = make_transactions(
        graphs,
        transaction_id="root_task_cluster",
        node_label=stable_node_signature,
        edge_label=typed_directed_edge_signature,
    )

    frequent = directed_typed_gspan(
        tx_db,
        min_support=cfg.min_support,
        max_nodes=10,
        max_edges=12,
        retain_closed=True,
    )

    anchors = select_anchors(
        graphs,
        signals=[
            "trace_credit",
            "token_cost",
            "critical_path",
            "success_failure_contrast",
            "recovery_value",
        ],
    )

    utility_patterns = bounded_beam_growth(
        tx_db,
        anchors=anchors,
        beam_width=cfg.beam_width,
        max_nodes=8,
        prune_by_utility_upper_bound=True,
    )

    episodes = mine_partial_order_episodes(
        graphs,
        min_length=3,
        max_length=8,
        max_span=cfg.max_episode_span,
    )

    candidates = canonical_merge(
        frequent + utility_patterns + materialize(episodes),
        occurrence_jaccard_threshold=0.95,
    )

    frozen = []
    for pattern in candidates:
        occurrences = exact_recount(pattern, graphs)

        if effective_independent_support(occurrences) < cfg.min_n_eff:
            if not qualifies_as_rare_high_value(pattern, occurrences):
                continue

        template = typed_anti_unify(pattern, occurrences)

        if not interface_closed(template):
            continue
        if not effects_fully_declared(template):
            continue

        discovery_stats = estimate_matched_utility(
            template,
            discovery,
            cluster_by="root_task_cluster",
            adjust_for=[
                "repo",
                "task_family",
                "difficulty",
                "model_version",
                "budget",
                "time",
            ],
            bootstrap=True,
        )

        tuning_stats = validate_frozen_candidate(
            template, tuning, allow_modification=False
        )

        if candidate_gate(template, discovery_stats, tuning_stats):
            frozen.append(
                freeze_immutable_candidate(
                    template,
                    discovery_stats,
                    tuning_stats,
                )
            )

    promoted_to_shadow = []
    for candidate in frozen:
        result = validate_on_locked_holdout(
            candidate,
            locked_holdout,
            exact_matching=True,
            evaluate_bindability=True,
            evaluate_noninferiority=True,
        )

        if holdout_gate(candidate, result):
            promoted_to_shadow.append(
                publish_as_shadow(candidate, result)
            )

    return promoted_to_shadow
```

---

## 十、质量阈值

以下是 **MVP 默认建议值**，不是上述论文给出的统一标准。

### 10.1 Discovery

| 通道 | 默认门槛 |
|---|---|
| Frequent lane | `n_eff ≥ 20`，weighted support ≥ 5%，覆盖至少 3 个 repo 或 task family |
| 小型语料库 | absolute support 可降至 10，但只能进入 candidate |
| Rare utility lane | `n_eff ≥ 5`，utility 方向一致，不得直接生产晋级 |
| 模式规模 | 3–10 节点，≤12 条边，≤6 个 boundary ports |

### 10.2 Bindability

```text
slot binding success       ≥ 98%
interface closure success  ≥ 99%
unresolved required slots  ≤ 1%
type/effect validation     = 100%
```

### 10.3 Shadow 样本

```text
只读/普通模板       ≥ 30 个独立 paired tasks
能写 workspace 的模板 ≥ 100
部署/删除/安全敏感     建议 ≥ 300，且 critical failure = 0
```

### 10.4 Outcome Gate

```text
95% LCB(success_delta) > -2 percentage points
```

安全敏感模板：

```text
95% LCB(success_delta) >= 0
critical safety violations = 0
```

并至少满足一项：

```text
95% LCB(net_utility) > 0
median token saving >= 5%
median latency saving >= 5%
success rate absolute lift >= 3pp
```

异质性门槛：

```text
任一主要 task family 的估计退化不得超过 5pp
跨 repo 效果方向一致率 >= 70%
```

只在特定任务族有效的模式应发布为 scoped template，不能标成全局模板。

### 10.5 生命周期

```text
raw motif
  → candidate
  → offline-validated
  → shadow
  → challenger
  → champion
  → deprecated / retired / quarantined
```

禁止：

```text
frequent pattern → 直接 champion
```

---

## 十一、版本化与迁移

### 11.1 四条独立版本轴

| 版本 | 例子 | 管什么 |
|---|---|---|
| `schema_version` | `0.1.0` | 字段、默认值、类型规则、canonicalization |
| `template_version` | `1.3.0` | 模板公开 ports、slots、控制和行为契约 |
| `runtime_version` | `0.4.2` | scheduler、retry、cache、checkpoint、effect enforcement |
| artifact version/digest | SHA-256 | prompt、tool、code、model policy、evaluator |

SemVer 可以表达兼容意图，但精确身份必须由 digest 决定。已经发布的同一版本不得用不同内容重新发布。citeturn366027search3

### 11.2 Template SemVer

#### PATCH

- 不改变 ports/slot 类型/effect；
- 修复内部实现或 prompt；
- 必须通过非劣验证；
- 即使是 PATCH，也必须产生新 digest。

#### MINOR

- 增加带安全默认值的 optional slot；
- 增加 optional output；
- 增加 opt-in branch；
- 扩大兼容范围但不破坏已有 binding。

#### MAJOR

- 删除、重命名 slot/port；
- 改变类型；
- 改变默认值含义；
- 改变副作用、输出契约、join、termination 或 loop 语义；
- 提高所需权限；
- 移除 runtime capability。

### 11.3 Immutable Release

每次发布都产生不可变记录：

```yaml
logical_id: core/bugfix-basic
template_version: 1.2.0
spec_digest: sha256:...
parent_release: sha256:...
supersedes: sha256:...
lifecycle: challenger
rollback_target: sha256:...
```

`latest`、`champion`、`candidate` 只是 catalog alias，可以移动；实际 run 必须记录确切 digest。

### 11.4 Migration

Schema migration 使用纯函数 upcaster：

```text
0.1 object
  → upcast_0_1_to_0_2()
  → 0.2 canonical internal object
  → validate
  → compile
```

要求：

- deterministic；
- idempotent；
- 保留原始对象和原始 digest；
- 记录 migration code digest；
- 使用 golden fixtures 测试；
- 跨 major 且无法保证语义时，不得静默 upcast；
- 应生成新 template release 并重新验证；
- MVP 不提供 downcast。

### 11.5 Rollback

Rollback 不修改历史 artifact，只移动 alias：

```text
champion:
  v1.3.0 → v1.2.2
```

正在执行的 run 不热切换版本；新任务使用回滚后的 alias。

### 11.6 Quarantine

一旦发现：

- 数据污染；
- evaluator 漏洞；
- 恶意 prompt/tool；
- 安全副作用；
- 错误迁移；

应按 provenance 对该 release 及其后代执行级联 quarantine，而不是简单删除历史记录。

---

## 十二、必须保留的反方约束

该方案不应被描述为“图 DSL 可以表示一切”。

### Go 条件

- promoted template 的 opaque code escape-hatch 节点占比低于约 20%；
- 编译后在 golden traces 上保持 100% port/effect/control 一致；
- 相比 code-authoritative baseline，至少在检索、归因、成本或成功率一个维度产生显著净收益；
- 写操作全部进入 snapshot/effect/idempotency 管理；
- prompt、model policy、tool adapter 和 runtime 均可追溯；
- evaluator false positive 得到 executable oracle 或人工 gate 控制。

### No-Go / 降级条件

| 失败信号 | 降级方式 |
|---|---|
| DSL escape hatch 过多 | 回退 code-authoritative，图仅作派生 view |
| 图检索无明显增益 | NL embedding + metadata filter |
| 图同构开销过高 | typed operator n-gram / episode mining |
| evaluator 不可靠 | 禁止自动 promotion |
| effect 无法声明 | 仅允许 pure/read-only 子图进入稳定库 |
| OOD 明显退化 | uncertainty gate，回退通用 planner |
| schema 迁移成本失控 | 冻结当前 schema major，新能力留在 code-native 层 |

---

## 十三、建议 MVP 实施顺序

### M0：Schema 与观测基线

1. `WorkflowTemplate` JSON Schema；
2. trace → typed occurrence DAG；
3. validator/type/effect checker；
4. strict canonicalizer；
5. `spec_digest` / `shape_digest`；
6. immutable CAS + catalog。

### M1：人工模板闭环

1. 手工创建 5–10 个 coding workflow；
2. template binding；
3. graph compiler/runtime；
4. RunRecord 和 provenance；
5. shadow/challenger/champion 生命周期。

### M2：离线蒸馏

1. frequent lane；
2. utility anchor lane；
3. typed anti-unification；
4. exact recount；
5. frozen holdout。

### M3：安全自动晋级

1. plan-only shadow；
2. read-only shadow；
3. paired canary；
4. 5% → 20% → 50% deployment；
5. 自动监控和 alias rollback。

---

# 最终结论

**WS6 应采用：受限、Graph-centered、单一权威源的三层混合 IR。**

- `WorkflowTemplate`：参数化 typed graph，作为库中权威；
- `WorkflowInstance`：绑定后的不可变执行权威；
- code/tool/model/prompt：内容寻址的执行 artifact；
- NL routine/insight/embedding：检索和解释视图；
- code-native：动态或副作用不透明 workflow 的实验性 fallback；
- 子图蒸馏：frequent、utility、episode 三路发现，必须经过 anti-unification、独立 support、locked holdout 和 shadow promotion；
- 库：immutable releases、独立版本轴、纯函数 upcaster、alias rollback、provenance quarantine。

这一路线同时吸收了 AWM、ADAS、ExpeL、Voyager 和 GPTSwarm 的长处，又补上了它们共同缺失的 **typed contracts、canonical identity、质量门禁和安全演化生命周期**。
