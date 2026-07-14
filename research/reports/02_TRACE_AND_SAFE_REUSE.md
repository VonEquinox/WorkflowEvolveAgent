# WS1 + WS2 收敛设计报告

**范围**：execution trace schema、content-addressing、安全语义去重、近似复用、repo 依赖与缓存失效。  
**状态**：已并行完成构建系统、语义缓存、proof/provenance、文献核验四条完整研究流；trace 与 MVP 两条研究流在整合阶段提前收敛。  
**文件变更**：未修改 `/Users/vonequinox/Program/GithubProjects/WorkflowEvolutionAgent/SELF_EVOLVING_AGENT_RESEARCH_PLAN.md`。

---

## 一、执行结论

原计划方向正确，但当前：

```text
Node {
  task
  input_hash
  output
  cost
  consumers
}
```

不足以支撑安全复用。它混合了五种生命周期和身份不同的对象：

1. 逻辑工作流节点；
2. 某次实际执行；
3. 不可变输出 Artifact；
4. 缓存索引；
5. 复用证书与验证结果。

建议确立以下总架构：

```text
Graph IR            逻辑工作流、契约、端口、策略
    ↓ instantiate
Execution Trace IR  某次运行、attempt、依赖观测、成本、cache decision
    ↓ produce
Artifact CAS        不可变输出，按内容摘要存储
    ↓ attest
Reuse Certificate   输入、依赖、权限、环境、验证器和有效期
    ↓ index
Exact / Semantic / Adapt Cache
```

四条核心原则：

> **内容地址负责完整性；依赖验证负责新鲜性；契约和验证器负责可替换性；embedding 只负责找候选。**

> **Content-addressed 不等于 safe-to-reuse。**

> **语义相似不等于任务等价。**

> **未知状态一律 fail closed。**

---

# 二、版本化 Graph / Trace IR

## 2.1 必须拆成四类核心实体

### A. Graph IR：逻辑定义

```yaml
GraphIR:
  schema: wea.graph/v1
  schema_version: 1.0.0
  key_schema_version: key-v1
  canonicalization: canonical-json-v1

  graph_id: digest
  revision_id: digest
  parent_revision_id: digest?

  entry_node: locate
  nodes: [NodeSpec]
  edges: [EdgeSpec]
  parameters: [ParameterSpec]
  policies:
    security_policy_ref: policy://...
    default_cache_policy: exact-only
    budget: {tokens: 50000, wallclock_ms: 900000}
```

```yaml
NodeSpec:
  logical_node_id: locate
  operation:
    kind: repo.symbol-index
    version: 1
    implementation_digest: sha256:...

  contract:
    input_ports: [...]
    output_ports: [...]
    preconditions: [...]
    postconditions: [...]
    output_schema: wea.repo-map/v1

  effects:
    class: PURE | READ_ONLY | IDEMPOTENT_WRITE |
           CONTENT_ADDRESSED_WRITE |
           NON_IDEMPOTENT_WRITE | EXTERNAL_SIDE_EFFECT
    declared_read_scope: [...]
    declared_write_scope: [...]
    network_policy: deny | pinned | live

  runtime:
    agent_version: ...
    prompt_template_digest: ...
    model_policy: ...
    tool_schema_digest: ...
    toolchain_digest: ...

  cache_policy:
    allowed_modes: [EXACT, SEMANTIC, ADAPT]
    risk_class: S1
    verifier_refs: [...]
    max_age_seconds: null

  retry_policy: ...
  timeout_ms: ...
```

### B. Trace IR：一次运行的事实

```yaml
ExecutionRun:
  schema: wea.trace/v1
  run_id: uuid
  trace_id: hex
  graph_revision_id: digest
  root_task_digest: digest

  repo_snapshot_id: digest
  policy_epoch: integer
  security_partition: hmac:...

  started_at: timestamp
  ended_at: timestamp
  status: success | failure | cancelled
  attempts: [NodeAttempt]
```

```yaml
NodeAttempt:
  attempt_id: uuid
  logical_node_id: locate
  attempt_no: 1

  span_context:
    trace_id: ...
    span_id: ...
    parent_span_id: ...

  input_bindings: [ArtifactBinding]
  declared_dependencies: [DependencySelector]
  observed_dependencies: [DependencyObservation]
  outputs: [ArtifactRef]

  cache_decision:
    requested_mode: EXACT
    final_mode: EXACT | SEMANTIC | ADAPT | MISS
    candidate_ids: [...]
    gate_results: [...]
    source_attempt_id: uuid?
    fallback_reason: string?

  execution:
    executor_digest: digest
    model_revision: string?
    inference_config_digest: digest
    toolchain_digest: digest
    environment_digest: digest

  effects:
    reads_root: digest
    writes_root: digest
    network_events_root: digest
    undeclared_reads: [...]
    undeclared_writes: [...]

  timing:
    planned_at: timestamp
    ready_at: timestamp
    started_at: timestamp
    ended_at: timestamp

  cost:
    input_tokens: integer
    output_tokens: integer
    cached_input_tokens: integer
    wallclock_ms: integer
    monetary_cost: decimal

  status: success | failure
  error: object?
```

### C. Artifact：不可变输出

```yaml
Artifact:
  artifact_id: sha256:...
  media_type: application/vnd.wea.repo-map+json
  logical_schema: wea.repo-map/v1
  size_bytes: integer
  storage_ref: cas-private://sha256/...

  producer_attempt_id: uuid
  source_snapshot_id: digest

  claims: [...]
  coverage: [...]
  limitations: [...]

  classification: internal
  taints:
    - untrusted-repository-text
  created_at: timestamp
  expires_at: timestamp?
```

### D. DependencyObservation：依赖事实

```yaml
DependencyObservation:
  kind:
    file_content
    | file_metadata
    | directory_membership
    | absence
    | glob_result
    | search_result
    | env
    | toolchain
    | model_runtime
    | node_output
    | network
    | clock
    | random

  locator: object
  selector_digest: digest?
  observed_digest: digest
  provenance: declared | discovered

  capture_method:
    sandbox | syscall_trace | tool_wrapper |
    dep_file | query_manifest | explicit | unknown

  completeness:
    complete | conservative | incomplete
```

---

## 2.2 边必须是一等实体

计划中的 `consumers` 不应直接维护在 Node 内，应由 Artifact 级边表达，再把 consumers 做成物化反向索引：

```yaml
EdgeSpec:
  edge_id: digest
  from: {node: locate, port: repo_map}
  to:   {node: implement, port: context}

  type:
    DATA_DEP
    | CONTROL_DEP
    | SPAWN
    | JOIN
    | FEEDBACK
    | LATERAL_BROADCAST
    | STATE_DEP
    | RESOURCE_CONFLICT
    | INVALIDATES

  required: true
  condition: expression?
  transform_ref: adapter://projection-v1?
```

执行 trace 额外记录：

```text
REUSE_OF
ADAPTS_FROM
VALIDATES
HAPPENS_BEFORE
```

证书依赖图必须保持 DAG；运行时环应展开为 `attempt-1 → attempt-2 → attempt-3`，不能让最终证书相互循环引用。

---

## 2.3 版本演化规则

建议 Graph、Trace、Artifact schema、key schema 分开版本化：

| 版本 | 含义 |
|---|---|
| `graph_schema_version` | 逻辑节点、边、端口、控制结构 |
| `trace_schema_version` | attempt、事件、依赖观测 |
| `artifact_schema_version` | 输出数据格式 |
| `certificate_version` | 复用证书 predicate |
| `key_schema_version` | 哪些字段进入 hash |
| `canonicalization_version` | JSON/Proto 规范化方法 |

兼容规则：

- **Major**：字段语义或 hash 语义变化；旧 cache 默认不能 exact hit。
- **Minor**：增加非必需字段；允许 upcast。
- **Patch**：文档、约束或实现修复，不改变序列化身份。
- 未识别的普通观测字段可保留并转发。
- 未识别的 **hash-critical/security-critical** 字段必须拒绝，不能忽略。
- migration 产生新视图，但保留原始 bytes、原 digest 和原版本。
- `key_schema_version` 改变时，旧记录可以作为 semantic/adapt 候选，但不能直接 exact 命中。

---

## 2.4 与 OpenTelemetry 的关系

OpenTelemetry 可作为兼容的传输和观测外壳：

| 本项目对象 | OTel 映射 |
|---|---|
| Workflow Run | root/workflow span |
| NodeAttempt | agent/workflow child span |
| Tool call | tool span 或 span event |
| DAG 非父子依赖 | Span Link |
| 跨 trace cache reuse | Link 到原 producer span |
| runtime/container | Resource |
| instrumentation library | InstrumentationScope |
| 错误、重试、cache reject | Event/Status |

OTel Span 有单一 parent，但可以通过 Links 指向其他 span，适合补充表达 DAG 和跨 trace 关系；不过依赖 manifest、Artifact consumption、cache certificate 等必须自定义。OTel 允许采样、丢弃和后端裁剪，因此不能作为缓存正确性的唯一事实源。citeturn360402search0turn360402search1

截至 **2026 年 7 月 13 日**，OpenTelemetry GenAI semantic conventions 已独立维护，仍处于快速演化的 Development 状态。建议固定 exporter 适配版本，而不是让核心 IR 直接依赖其滚动字段。citeturn735656view0

另外，不要把完整 prompt、response、源码、工具参数写进普通 span attributes；默认只写 digest、大小、schema、分类标签和受保护 Artifact 引用。

---

# 三、Cache Key 分层设计

## 3.1 不应再使用单个 `input_hash`

推荐至少六层：

| 层 | 名称 | 回答的问题 |
|---|---|---|
| L0 | `artifact_id` | 两个输出内容是否完全相同？ |
| L1 | `operation_key` | 两个逻辑任务和输出契约是否相同？ |
| L2 | `context_key` | producer/runtime/security 语义是否兼容？ |
| L3 | `flight_key` | 当前两个执行能否 singleflight 合并？ |
| L4 | `realization_key` | 实际依赖闭包是否完全相同？ |
| L5 | `semantic_retrieval_key` | 哪些旧结果可能相关？ |
| L6 | `adaptation_key` | 某旧结果到新 contract 的适配是否执行过？ |

推荐公式：

```text
artifact_id =
  H(domain="artifact", canonical_output_bytes)

operation_key =
  H(key_schema_version,
    canonical_task_contract,
    node_implementation_digest,
    output_contract_digest)

context_key =
  H(runtime_fingerprint,
    toolchain_digest,
    model_and_prompt_policy,
    environment_contract,
    security_partition,
    policy_epoch)

flight_key =
  H(operation_key,
    context_key,
    declared_scope_snapshot_root)

realization_key =
  H(operation_key,
    context_key,
    actual_dependency_manifest_root)

semantic_retrieval_key =
  Embedding({
    task_kind,
    normalized_objective,
    entities,
    scope,
    output_schema,
    temporal_scope
  })

adaptation_key =
  H(source_certificate_digest,
    target_contract_digest,
    adapter_implementation_digest,
    target_snapshot_digest)
```

Bazel/Remote Execution API 明确区分 Action Cache 与 CAS；Action 身份绑定 Command、输入 Merkle root、平台和执行相关字段，而输出 blobs 另按 digest 存储。这直接支持“执行身份”和“输出内容身份”分离。citeturn767402view0turn763790view0

---

## 3.2 为什么采用两阶段 key

动态依赖在执行前可能未知，因此不能总在开始前得到最终 exact key：

```text
阶段 1：按 operation_key/context_key 找历史候选
阶段 2：读取候选的历史 dependency manifest
阶段 3：在当前快照验证每个 dependency digest
阶段 4：全部匹配才构成 exact hit
```

这比：

```text
H(整个 repo + 完整 prompt)
```

命中率高，也比：

```text
H(task 自然语言)
```

安全得多。

如果依赖捕获不完整：

```text
dependency_manifest.completeness != complete
```

则结果只能：

- local-only；
- evidence-only；
- 或完全不进入共享缓存。

---

# 四、安全复用闸门与 Certificate

## 4.1 闸门执行顺序

复用必须依次通过：

1. **Schema gate**：版本和 hash profile 可理解；
2. **Integrity gate**：Artifact digest、证书签名有效；
3. **Trust gate**：producer/builder 在允许列表；
4. **Authority gate**：tenant、project、confidentiality、purpose 兼容；
5. **Contract gate**：旧 artifact 对新 contract 的非对称满足关系成立；
6. **Dependency gate**：实际正依赖、负依赖均未变化；
7. **Freshness gate**：版本、ETag、snapshot、有效期满足要求；
8. **Environment gate**：工具链、平台、模型/提示词策略兼容；
9. **Effect gate**：跳过执行不会漏掉必要副作用；
10. **Noninterference gate**：没有并发写冲突、权限泄漏或控制流污染；
11. **Verifier gate**：新 contract 要求的后置条件已被可靠验证；
12. **Risk gate**：该 bucket 的错误率上界低于预算。

任一关键结果为 `UNKNOWN`：

```text
EXACT/SEMANTIC direct hit = 禁止
ADAPT 或 MISS
```

---

## 4.2 Contract 必须是非对称关系

不要定义：

```text
similar(A, B)
```

应定义：

```text
DIRECTLY_SATISFIES(old_artifact, new_contract)
ADAPTABLE_TO(old_artifact, new_contract)
RELATED_BUT_NOT_REUSABLE
CONTRADICTORY
```

例如，包含全仓 symbols/imports 的结构化 RepoMap 可以直接满足“只取 auth 模块 symbols”的窄请求；反方向不成立。

Embedding 语义缓存项目通常使用 embedding 和相似度评估召回旧回答，但这类机制本身不证明任务、时效、权限和副作用等价。citeturn268263search1turn268263search3

---

## 4.3 复用证书能证明什么

建议采用类似 in-toto Statement 的：

```text
subject + project-specific predicate
```

外壳，内部至少包含：

```yaml
ReuseCertificate:
  certificate_version: 1.0.0

  subject:
    artifact_digest: sha256:...

  task:
    task_spec_digest: sha256:...
    operation_key: sha256:...
    realization_key: sha256:...
    result_mode: execution-equivalent | result-satisfies | evidence-only

  producer:
    executor_digest: sha256:...
    model_revision: ...
    prompt_digest: hmac-sha256:...
    toolchain_digest: sha256:...

  inputs:
    dependency_manifest_root: sha256:...
    negative_dependency_root: sha256:...
    external_inputs_root: sha256:...

  environment:
    environment_contract_digest: sha256:...
    actual_environment_digest: sha256:...
    hermetic: true | false

  effects:
    side_effect_mode: pure | idempotent | non-replayable
    observed_read_set_root: sha256:...
    observed_write_set_root: sha256:...
    network_events_root: sha256:...
    undeclared_reads: [...]
    undeclared_writes: [...]

  authority:
    tenant: opaque-id
    project: opaque-id
    classification: internal
    compartments: [...]
    capabilities_used: [...]

  security:
    taints: [...]
    allowed_consumers: [...]
    allowed_purposes: [...]

  validators:
    - validator_digest: sha256:...
      predicate: repo-map-schema-valid
      evidence_digest: sha256:...
      result: pass
      expires_at: null

  validity:
    issued_at: timestamp
    expires_at: timestamp?
    policy_digest: sha256:...
    invalidation_topics: [...]

  provenance:
    parent_certificate_roots: [...]
    trace_id: ...
    attempt_id: ...
```

in-toto Attestation Framework、SLSA provenance 和 W3C PROV 分别提供了 subject/predicate、供应链 provenance expectations，以及 Entity/Activity/Agent 血缘模型；它们适合作为证书和血缘基础，但不会自动证明 LLM 输出在开放世界中“语义正确”。citeturn732922search0turn732922search1turn732922search2

证书可以证明：

- bytes 与 digest 一致；
- 某受信任身份签发了声明；
- 声明的输入、环境和读写集满足某条件；
- 某验证器对特定谓词给出 pass；
- 依赖证书链当前有效。

证书不能自动证明：

- 输出总体正确；
- 未捕获的隐藏依赖不存在；
- 测试通过意味着没有漏洞；
- 文本没有 prompt injection；
- 两个高相似任务语义等价。

---

## 4.4 安全传播规则

```text
output.classification =
    join(all_input_classifications)

output.taints =
    union(all_input_taints)

output.expires_at =
    min(required_dependency_expiries)

output.postconditions =
    only locally proven or logically entailed claims
```

关键原则：

> **数据可以传播污染，但不能传播权限。**

历史证书中的 capability 只是审计事实，不是当前消费者可复用的凭证。

对缓存中的 repo/web 文本：

- 永远作为 data，而不是 system/developer/control instruction；
- prompt-injection taint 默认 sticky；
- 带 taint 内容不得直接决定 tool name、shell command、网络目标、权限或资源范围；
- 降低安全标签只能由显式受信任 sanitizer/declassifier 完成。

---

# 五、Repo 状态、依赖和失效传播

## 5.1 Git HEAD 不足以代表当前工作区

Git 的 tree/commit 是内容寻址对象，但当前工作区还可能包含：

- index/staged 内容；
- tracked dirty files；
- untracked files；
- ignored/generated files；
- symlink 和 executable bit 变化。

这些状态都可能改变搜索、导入解析、测试和构建结果，因此 `HEAD` 或 branch name 不能直接作为完整 repo cache key。citeturn276203search0turn276203search1turn276203search2

推荐：

```yaml
RepoSnapshot:
  base_commit: git:...
  visibility_policy_digest: sha256:...

  overlay:
    index_tree_digest: sha256:...
    worktree_changes_root: sha256:...
    visible_untracked_root: sha256:...
    generated_artifacts_root: sha256:...

  snapshot_merkle_root: sha256:...
```

最安全的执行模型是让每个节点读取不可变 snapshot，并将修改输出为 patch/artifact，而不是直接在共享 live working tree 上边读边写。

---

## 5.2 不能只跟踪“读到的文件”

必须跟踪：

| 类型 | 原因 |
|---|---|
| `file_content` | 文件 bytes 变化 |
| `file_metadata` | mode、symlink、类型变化 |
| `directory_membership` | 新增/删除文件可能改变结论 |
| `absence` | “文件不存在”也是依赖 |
| `glob_result` | 新文件可能加入匹配结果 |
| `search_result` | 搜索范围或索引变化 |
| `env` | feature flags、locale、语言路径 |
| `toolchain` | 编译器、解释器、shell、工具 |
| `network` | API response、ETag、网页版本 |
| `clock/random` | “最新”、日期、随机采样 |
| `node_output` | 上游 Artifact 或 Certificate |

特别是：

```text
“没有发现 X”
“仓库中不存在 Y”
“所有测试都通过”
```

属于开放或范围查询，必须绑定搜索作用域、目录成员、索引版本或整个保守 scope root。

---

## 5.3 失效传播算法

反向依赖索引：

```text
reverse_deps[dependency_locator] -> cache_entry_ids
downstream[artifact_id]          -> consumer_entry_ids
```

变更时：

```python
def on_change(event):
    affected = map_event_to_dependency_locators(event)

    for dep in affected:
        new_digest = fingerprint(dep)

        if new_digest == dependency_state[dep].digest:
            continue

        dependency_state[dep].digest = new_digest

        for entry_id in reverse_deps[dep]:
            cache[entry_id].state = "SUSPECT"
```

查用时做权威的惰性验证：

```python
def validate_entry(entry, current_world):
    if entry.manifest_completeness != "complete":
        return False

    if entry.security_partition != current_world.security_partition:
        return False

    if entry.policy_epoch != current_world.policy_epoch:
        return False

    for dep in entry.dependencies:
        if fingerprint(dep, current_world) != dep.observed_digest:
            return False

    return True
```

**反向失效只是加速；正确性必须依赖查用时验证。**否则漏掉一个文件系统事件就可能产生错误命中。

Early cutoff 只应在以下情况下使用：

```text
上游已经重算或重新验证
AND 新旧 artifact digest/guarantee 相同
```

不能因为“推测输出大概没变”就停止传播。Build Systems à la Carte 对依赖 trace、dirty checking 和非确定性任务边界的讨论直接支持这一谨慎原则。citeturn799170search2turn539214view0

---

## 5.4 并发与 TOCTOU

Singleflight key：

```text
flight_key =
  H(operation_key,
    context_key,
    declared_scope_snapshot_root,
    policy_epoch)
```

必须处理：

- 执行期间 repo generation 变化；
- 两个节点同时写相同路径；
- cache validation 后、materialize 前状态又变化；
- lease owner 崩溃；
- 旧计算晚于新计算完成并覆盖结果。

建议：

1. 读取不可变 snapshot；
2. 写入隔离 overlay/worktree；
3. cache publish 使用 compare-and-swap；
4. lease 绑定 generation；
5. publish 时再次验证 snapshot；
6. live workspace 变化时禁止发布 exact certificate。

---

# 六、EXACT / SEMANTIC / ADAPT 三档策略

| 档位 | 判定条件 | 行为 | 默认范围 |
|---|---|---|---|
| **EXACT** | task、contract、runtime、权限、依赖闭包、freshness 全兼容 | 直接 materialize Artifact | 确定性工具节点、结构化只读结果 |
| **SEMANTIC** | 文本不同，但旧 Artifact 的 claims/coverage 已直接满足新 contract | 验证后直接交给消费者 | 低风险、结构化、只读、可机器验证 |
| **ADAPT** | 旧 Artifact 不足以直接交付，但可低成本派生 | 执行 adapter，验证并签发新证书 | repo map 投影、增量摘要、patch rebase |
| **MISS** | 只有相似度，或任一关键条件未知 | 完整重算 | 默认回退 |

## EXACT

允许：

- 相同 snapshot 下复用 AST/symbol index；
- 相同输入闭包和工具链下复用构建/test artifact；
- 相同文件 digest 下复用结构化 repo map。

禁止：

- 依赖 manifest 不完整；
- live network 未固定；
- 模型使用可变 alias 且输出无强 verifier；
- 非幂等外部副作用；
- 跨权限域直接复用。

## SEMANTIC

只有以下情况适合直接复用：

```text
旧 Artifact 是结构化事实
AND coverage 覆盖新 scope
AND requested fields 是旧 claims 的子集
AND 依赖/时效/权限均有效
AND 新 postcondition 可机器验证
```

自由文本总结默认只能作为 `evidence-only`，不能作为权威 direct hit。

## ADAPT

ADAPT 是一个**新的执行节点**，不应计作 cache hit：

```text
source artifact
   ↓ adapter execution
new artifact
   ↓ new verifier
new certificate
```

成本判定：

```text
reuse_cost =
  retrieval_cost
  + certificate_validation_cost
  + adaptation_cost
  + verification_cost
  + P(adapt_failure) * recompute_cost
  + risk_penalty
```

仅当：

```text
reuse_cost < expected_recompute_cost
AND residual_risk <= risk_budget
```

才走 ADAPT。

代码 patch 的 ADAPT 至少要求：

- 绑定旧 patch 的 base/preimage digest；
- 在隔离 worktree 中 3-way apply/rebase；
- 冲突或 fuzz 不自动视为成功；
- 运行受影响测试；
- 失败后回退完整重算。

---

# 七、MVP 数据结构与核心伪代码

## 7.1 最小存储表

```text
graph_revisions(
  graph_revision_id,
  schema_version,
  canonical_blob_digest
)

execution_attempts(
  attempt_id,
  run_id,
  logical_node_id,
  snapshot_id,
  status,
  trace_blob_digest
)

artifacts(
  artifact_id,
  media_type,
  schema_version,
  storage_ref,
  security_label
)

cache_entries(
  entry_id,
  operation_key,
  context_key,
  realization_key,
  artifact_id,
  certificate_id,
  state,
  created_at
)

cache_dependencies(
  entry_id,
  dep_locator_hash,
  dep_kind,
  selector_digest,
  observed_digest
)

reuse_certificates(
  certificate_id,
  artifact_id,
  predicate_blob_digest,
  signer,
  expires_at
)

reuse_decisions(
  decision_id,
  request_attempt_id,
  candidate_entry_id,
  final_mode,
  gate_results_blob,
  estimated_risk,
  saved_tokens
)
```

索引：

```text
(operation_key, security_partition) -> exact candidates
dep_locator_hash                    -> dependent cache entries
artifact_id                         -> consumers
semantic ANN index                  -> candidate entry IDs
flight_key                          -> in-flight future/lease
```

缓存状态机：

```text
ABSENT
  → COMPUTING
  → PROVISIONAL
  → VERIFIED
  → ACTIVE
  → SUSPECT
  → STALE / INVALID / QUARANTINED / EVICTED
```

---

## 7.2 总体路由伪代码

```python
def resolve_or_execute(request, world):
    contract = canonicalize_contract(request)
    op_key = compute_operation_key(contract)
    context_key = compute_context_key(request, world)

    # 1. EXACT candidate lookup
    for entry in rank_exact_candidates(
        cache.lookup(op_key, world.security_partition)
    ):
        decision = verify_certificate(
            entry.certificate,
            request=request,
            world=world,
            requested_mode="EXACT",
        )

        if decision == "ALLOW_EXACT":
            return materialize(entry.artifact, mode="EXACT")

    # 2. Semantic candidates: retrieval only
    if request.policy.allow_semantic:
        candidates = semantic_index.search(
            embedding=embed(retrieval_view(request)),
            partition=world.security_partition,
            top_k=request.policy.top_k,
        )

        for entry in candidates:
            relation = contract_relation(
                entry.artifact_claims,
                request.contract,
            )

            if relation == "DIRECTLY_SATISFIES":
                decision = verify_certificate(
                    entry.certificate,
                    request,
                    world,
                    requested_mode="SEMANTIC",
                )

                if decision == "ALLOW_EXACT" and \
                   verify_new_postconditions(entry.artifact, request):
                    return materialize(entry.artifact, mode="SEMANTIC")

            if relation == "ADAPTABLE":
                if should_adapt(entry, request, world):
                    adapted = execute_adapter_in_snapshot(
                        source=entry.artifact,
                        target=request,
                        snapshot=world.snapshot,
                    )

                    if verify_new_postconditions(adapted, request):
                        seal_and_publish(adapted)
                        return adapted

    # 3. Fresh execution with singleflight
    flight_key = compute_flight_key(request, world.snapshot)

    return singleflight(flight_key, lambda: execute_fresh(request, world))
```

```python
def execute_fresh(request, world):
    snapshot = world.create_immutable_snapshot()
    tracer = DependencyTracer(
        snapshot=snapshot,
        declared_scope=request.contract.declared_read_scope,
    )

    result = instrumented_execute(request, tracer)
    manifest = tracer.finalize()

    if manifest.undeclared_access:
        if request.policy.allow_scope_expansion:
            expanded = expand_scope(request, manifest.undeclared_access)
            return execute_fresh(expanded, world)
        return publish_noncacheable(result, "undeclared-access")

    if manifest.completeness != "complete":
        return publish_local_only(result, "incomplete-dependency-trace")

    validations = run_verifiers(result, request.contract)

    certificate = issue_certificate(
        request=request,
        result=result,
        snapshot=snapshot,
        dependency_manifest=manifest,
        validations=validations,
    )

    if certificate_allows_shared_cache(certificate):
        atomic_publish_to_cas_and_cache(result, certificate)

    return result
```

---

# 八、建议落地顺序

## Phase 0：只观测

- 上线 Graph/Trace IR；
- 记录 NodeAttempt、Artifact、依赖边、consumer 边；
- 不改变原 agent 行为；
- 测量理论 exact dedup 上界。

## Phase 1：保守 EXACT

只支持：

- 同一 tenant/project；
- immutable snapshot；
- PURE/READ_ONLY；
- 确定性工具节点；
- 完整 read-set；
- 无 live network/time/random；
- 结构化 Artifact；
- exact dependency validation。

## Phase 2：Semantic shadow mode

- 检索 top-k 但仍完整重算；
- 标注 `DIRECT / ADAPT / INVALID`；
- 构造 hard negatives；
- 按 task kind/risk/verifier strength 分桶校准。

## Phase 3：低风险 SEMANTIC

仅开放：

- 结构化 repo map；
- symbol/index/search artifact；
- 字段投影和 scope 子集；
- 可机器验证的只读结论。

## Phase 4：ADAPT

- 增量更新；
- patch rebase；
- 旧分析加新证据；
- 强制重新验证和签发新证书。

长期禁止：

- 仅按 cosine similarity 直接返回代码修改；
- semantic replay 部署、PR、数据库写入和外部 API 操作；
- 跨租户共享私有 embedding/KV/result；
- incomplete trace 进入共享 exact cache。

---

# 九、主要指标

正确性优先：

```text
DirectHitErrorRate
FalseSemanticAcceptRate
StaleHitRate
AuthorityViolationCount
IncompleteTracePublishCount
VerifierEscapeRate
```

效率指标：

```text
ExactHitRate
SemanticDirectHitRate
AdaptSuccessRate
ValidationOverhead
TokensSavedNet
WallclockSavedNet
SingleflightCollapseRate
InvalidationFanout
```

需要特别分开：

```text
llm_prefix_cache_hit
workflow_result_cache_hit
artifact_projection_reuse
```

SGLang RadixAttention 和 vLLM APC 复用的是相同 token prefix 的 KV 状态，主要节省 prefill，并不证明 workflow 子任务结果等价，不能算作 WS2 semantic result hit。citeturn947842search0turn893866view0

---

# 十、文献核验结论

| 文献/系统 | 核验结果 | 应如何引用 |
|---|---|---|
| **Build Systems à la Carte** | ✅ 编号和作者正确 | 原计划“记忆化 DAG 增量重建理论”表述过窄；核心是 scheduler/rebuilder 分解、动态依赖与多种 trace/rebuild 策略，不是语义缓存论文。citeturn799170search2turn799170search3 |
| **SGLang / 2312.07104** | ✅ 正确 | 支持 exact token-prefix KV 复用；不能支持子任务语义等价或 repo 失效。citeturn947842search0 |
| **LLMCompiler / 2312.04511** | ✅ 已从 arXiv/PMLR 核验 | 支持依赖感知的并行工具调用；不是通用 Graph IR 或 cache system。 |
| **Parrot / 2405.19888** | ✅ 已从 USENIX/arXiv 核验 | Semantic Variable 暴露应用 dataflow；不是自然语言等价判定器。 |
| **OpenTelemetry Trace** | ✅ 官方规范已核验 | 适合作为 exporter/observability envelope；不应作为 canonical cache/provenance 数据库。citeturn360402search0turn360402search3 |
| **OpenTelemetry GenAI conventions** | ✅ 已核验，Development | 可兼容 agent/workflow/tool/model usage 字段，但必须 pin 版本并设置适配层。citeturn735656view0 |
| **Bazel Remote Cache / REAPI** | ✅ 官方文档和 proto 已核验 | 是 exact action/result cache 最直接参考；必须迁移 AC/CAS 分离、输入 Merkle 闭包和环境语义。citeturn767402view0turn763790view0 |
| **Git object model** | ✅ 官方文档已核验 | 支持 CAS/Merkle snapshot，但 HEAD 不覆盖完整 working tree。citeturn276203search0turn276203search1 |

---

# 十一、仍未完全解决、必须实验验证的问题

1. **完整 read-set 捕获**：shell 子进程、编译器、LSP、Git、网络请求的捕获覆盖率与开销。
2. **TaskContract 语言**：如何表达 claims、coverage、scope subsumption 和 postconditions。
3. **LLM 非确定性**：provider 未暴露 immutable model revision 时，哪些输出仍可称 exact。
4. **Semantic benchmark**：缺少 coding-agent 子任务“可直接复用/可适配/不可复用”的 hard-negative 数据集。
5. **Verifier 覆盖率**：自由文本分析仍难获得高强度机器验证。
6. **搜索和负依赖**：如何低成本证明一次 `rg`/索引查询的扫描范围完整。
7. **跨 tenant 隐私**：即使 Artifact 加密，hit/miss、digest 和 ANN 结果仍可能形成存在性侧信道。
8. **证书信任根**：builder、validator、签名和撤销机制的运维成本。
9. **ADAPT 成本模型**：不同 repo、语言、任务类型必须单独校准。
10. **OpenTelemetry GenAI 字段稳定性**：当前仍为滚动规范，具体字段需在实现时再次核验。

---

## 最终推荐

WS1 的首版目标不应是“定义一个漂亮的 Node schema”，而应是建立：

```text
lossless Trace IR
+ immutable Artifact CAS
+ complete dependency manifest
+ cache decision audit
```

WS2 的首版目标不应是 embedding 语义去重，而应按以下顺序推进：

```text
确定性工具节点 EXACT memoization
→ in-flight singleflight
→ repo dependency tracking
→ reverse invalidation + lazy validation
→ output-digest early cutoff
→ 结构化 Artifact 的 projection reuse
→ semantic shadow mode
→ 最后才是 proof-gated SEMANTIC / ADAPT
```

一句话收敛：

> **Declared scope 是安全边界，observed manifest 是精确失效依据，content digest 是完整性标识，TaskContract + Certificate + Verifier 才是复用正确性边界。**
