# WS7/F 收敛报告：Workflow 检索、模板实例化、Per-task Graph Editing 与冷启动

> **状态**：已完成收敛；**未修改** `/Users/vonequinox/Program/GithubProjects/WorkflowEvolutionAgent/SELF_EVOLVING_AGENT_RESEARCH_PLAN.md`。  
> **核心建议**：MVP 不要直接上端到端 RL 或任意代码生成式 workflow editing，而应采用  
> **混合检索 → 硬约束过滤 → learned reranking → 类型安全的局部图编辑 → 静态验证 → 沙箱执行 → champion 回退**。

---

## 一、结论摘要

1. **检索不能只用 task embedding。** 推荐建立非对称的 **TaskCard/TemplateCard 双塔**，融合：
   - 稠密语义；
   - BM25/符号关键词；
   - repo、语言、工具、权限等元数据；
   - task capability sketch 与模板 graph signature；
   - 历史成功率、成本和失败模式后验。

2. **Hard constraints 必须先于 learned ranking。** 权限、工具可用性、端口类型、预算下界、循环上限、环境兼容性等不能交给模型“学会”，应由编译器式验证器决定。

3. **Graph editing 首先限制在“小半径、安全宏动作”。** MVP 只允许深度不超过 2 的局部编辑，例如：
   - 插入 verifier/tester；
   - 删除冗余分支；
   - 并行化独立步骤；
   - 添加 fan-in aggregator；
   - 添加 bounded retry；
   - 切换模型、工具和预算。

4. **MaAS 可借鉴 query-conditioned controller，但不是 template retrieval 方法；GPTSwarm 可借鉴边概率化，但不是 per-query 编辑；FlowReasoner 确实是 per-query workflow，但严重依赖当前 query 的可执行验证用例。**

5. **冷启动不能“库空就让 LLM 自由造图”。** 应先提供 3–4 个安全人工模板和一个规则路由器；积累预算匹配的候选执行数据后，再训练 reranker，最后才训练 edit policy。

6. **最终优化目标不是单纯成功率**，而是安全约束下的：

\[
\text{Utility} =
P(\text{success})
-\lambda_c \cdot \text{cost}
-\lambda_l \cdot \text{latency}
-\lambda_r \cdot \text{risk}
-\lambda_e \cdot \text{edit distance}
-\lambda_u \cdot \text{uncertainty}
\]

---

# 二、一手来源核验

## 2.1 MaAS

**核验结论：研究计划中的“按 query 从 supernet 采样子图”基本准确。**

MaAS 已发表于 ICML 2025。它维护一个概率化、分层的 agentic supernet，由 query-conditioned controller 为不同 query 采样不同的多智能体架构，并显式将 token cost 等资源成本放入优化目标。citeturn0view0

但需要加三个限定：

- 它优化的是**固定 operator space 上的条件架构分布**，不是从大型 Workflow IR 库做案例检索。
- 它的主结构是分层 DAG、operator 选择和 early exit，不是对任意已有图做自由的 add/delete/rewire patch。
- 它更适合作为 WS7 中的 **query-conditioned routing/controller 先例**，而不是完整 retrieval+editing 方案。

**可直接迁移：**

- query-conditioned operator selection；
- early exit；
- success/cost 联合目标；
- 为简单任务分配更少 agent/operator。

**不能直接外推：**

- template retrieval；
- 参数槽位绑定；
- repo 级 coding task 的环境约束；
- 任意图编辑安全性。

---

## 2.2 GPTSwarm

**核验结论：研究计划中的“优化边”准确，但它不是 per-query graph editing。**

GPTSwarm 将 operation 表示成节点、agent 表示成计算图、swarm 表示成多个 agent 图的组合；在论文设置中图被限制为 DAG。其边优化是在固定节点和固定候选边集合上，给潜在边参数化概率，再用 REINFORCE 优化期望任务 utility。节点 prompt 也可以单独迭代优化。论文发表于 ICML 2024。citeturn3view0

关键限定：

- 学到的通常是**任务级 edge distribution**，而非输入每个 query 后重新生成一套边。
- 重点是 agent 之间的通信边；论文也明确把动态改变内部节点拓扑留作后续工作。
- REINFORCE 的样本效率和方差意味着它不适合作为 WS7 MVP 的默认在线编辑器。

**可直接迁移：**

- 用 Bernoulli/logit 表示“可选边”；
- cycle mask；
- 固定 required edges、优化 optional edges；
- 以执行 utility 训练结构分布。

**不能直接外推：**

- node add/delete；
- typed slot binding；
- per-repo/per-query adaptation；
- 风险敏感或权限约束搜索。

---

## 2.3 FlowReasoner

**核验结论：研究计划中的“per-query 生成 MAS”准确，但必须注明它需要 query-level executable feedback。**

FlowReasoner 将 query-level meta-agent 形式化为：

\[
S_q=A_{\text{meta}}(q)
\]

先蒸馏多轮 workflow reasoning，再用带外部执行反馈的 GRPO 训练；工作流可以包含模型、prompt、温度、输出格式等节点参数，以及节点间数据流。论文实验集中在 HumanEval、MBPP、BigCodeBench 等代码生成任务，并固定进行多轮 workflow 优化。citeturn4view0

最重要的边界条件是：官方仓库明确要求把每个问题的测试用例拆成 `val` 和 `test`，其中 `val` 用作当前 query 的 workflow 优化反馈。citeturn3view1

因此：

- 它证明了“**如果当前 query 存在可靠、便宜、可重复执行的验证 oracle，per-query workflow 优化可行**”。
- 它没有证明在真实 repo issue、缺少 query-specific validation tests 时，也能稳定获得同样收益。
- 不能让 editor 访问最终隐藏 evaluator；否则会把“工作流适配”变成对评测用例的搜索。
- 官方引用目前仍以 arXiv 形式给出，结果应按较新、尚需独立复现的证据处理。citeturn3view1

---

## 2.4 AWM 对模板表示的支持

Agent Workflow Memory 从成功经验中诱导 workflow description 和参数化 action trajectory，将实例值抽象成槽位，再加入 agent memory。它支持“可复用 routine + 参数抽象”这个方向，但其原始方案主要是把 workflows 放入上下文，不是面向大型 IR 库的成熟 ANN retrieval、hard filtering 或 learning-to-rank 系统。citeturn1view0

---

# 三、Task/Template 双塔与混合检索 Key

## 3.1 不建议直接检索原始 issue 文本

建议先把新任务编译为结构化 `TaskCard`：

```text
TaskCard
├── semantic
│   ├── goal
│   ├── acceptance_criteria
│   ├── task_family: bugfix | feature | refactor | test | docs
│   └── ambiguity/novelty
├── repository
│   ├── languages/frameworks
│   ├── build/test/lint commands
│   ├── dependency/module summary
│   ├── candidate files/symbols
│   └── estimated change surface
├── capabilities
│   ├── inspect/search
│   ├── reproduce/debug
│   ├── implement
│   ├── test/review
│   └── web/tool/multi-agent requirements
├── oracle
│   ├── existing tests
│   ├── reproduction command
│   ├── static checks
│   └── whether trusted query-level feedback exists
└── constraints
    ├── allowed tools/models/network
    ├── write scope
    ├── secret/data policy
    ├── token/time/cost/parallelism budget
    └── risk tier
```

模板对应 `TemplateCard`：

```text
TemplateCard
├── semantics
│   ├── purpose
│   ├── supported task families
│   └── known failure signatures
├── graph
│   ├── typed Workflow IR
│   ├── node/operator roles
│   ├── graph embedding/signature
│   ├── critical path/fan-out/fan-in/loop stats
│   └── required safety nodes
├── interface
│   ├── input/output schemas
│   ├── typed slots
│   ├── preconditions
│   └── slot resolvers/defaults/validators
├── resources
│   ├── expected token/cost/latency quantiles
│   ├── minimum required budget
│   └── required models/tools
├── empirical history
│   ├── success posterior by task stratum
│   ├── sample count
│   ├── fallback rate
│   └── safety incidents
└── adaptation
    ├── allowed edit macros
    ├── maximum edit radius
    ├── immutable nodes/edges
    └── champion/version/provenance
```

---

## 3.2 双塔应是非对称双塔

### Task tower

编码：

\[
e_q=f_q(
\text{goal},
\text{repo fingerprint},
\text{capabilities},
\text{oracle},
\text{risk/budget},
G_{\text{req}}
)
\]

其中 \(G_{\text{req}}\) 不是最终 workflow，而是从任务中抽取的粗粒度 capability graph，例如：

```text
reproduce → localize → patch → test → review
```

### Template tower

编码：

\[
e_T=f_T(
\text{description},
\text{preconditions},
\text{slot schema},
G_T,
\text{resource profile}
)
\]

`G_T` 可由节点文本 embedding 与结构特征共同编码；MVP 不需要立即训练复杂 GNN，可以先使用：

- operator type histogram；
- WL-style graph hash；
- depth、width、critical path；
- verifier/tester/loop/aggregator 标志；
- required tool/capability bitmask。

---

## 3.3 推荐混合检索 Key

候选召回应取以下索引的并集：

```text
C =
TopK_BM25(task text, template description/failure tags)
∪ TopK_Dense(e_task, e_template)
∪ ExactMetadata(language/framework/task family/tool)
∪ TopK_GraphSim(requirement sketch, template signature)
```

初始召回分数：

\[
S_{\text{recall}}(q,T)=
\alpha\cos(e_q,e_T)
+\beta\,BM25(q,T)
+\gamma\,J_{\text{capability}}
+\delta\,Sim(G_{\text{req}},G_T)
+\rho\,Prior(T\mid \text{task stratum})
\]

建议：

- `BM25` 保留精确技术词、错误码、框架名、构建工具和文件类型；
- dense embedding 负责语义相似；
- metadata 防止 Python workflow 被召回到 Rust/C++ repo；
- graph similarity 判断任务是否需要 parallel explore、verifier、feedback loop；
- performance prior 只能来自**过去任务**，不能包含当前任务的测试结果。

---

# 四、Hard Constraints + Learned Ranking

## 4.1 Hard constraints

以下约束应在 learned ranker 之前执行，并且不能被 ranker 覆盖：

| 约束 | 示例 |
|---|---|
| 工具/模型可用性 | `required_tools(T) ⊆ allowed_tools(q)` |
| 环境兼容性 | 语言、框架、OS、runtime、模型版本兼容 |
| 槽位可绑定 | 所有 required slots 必须可解析并通过类型检查 |
| 端口类型 | 每条边的输出类型必须兼容目标输入类型 |
| 结构合法性 | 普通数据流无环；循环只能存在于显式 `BoundedLoop` |
| 权限 | 模板不得要求未授权网络、凭证、写目录或部署能力 |
| 预算下界 | 模板最小 token、时间、调用数不得超过任务预算 |
| 风险策略 | 高风险任务必须包含 verifier、sandbox 或人工 gate |
| 副作用顺序 | 写文件、提交、发请求等 effectful node 不得被非法重排或重复 |
| evaluator 隔离 | 当前任务最终隐藏评测结果不能作为检索或编辑输入 |

硬过滤失败时，**只能放宽语义相似度，不能放宽安全约束**。

---

## 4.2 Learned reranker

对通过 hard filter 的 top-K 模板，使用 task-template cross-encoder 或结构化 ranker，预测：

- 成功概率；
- token/cost/latency；
- 风险事件概率；
- 预计需要的 edit distance；
- 预测不确定性。

推荐最终排序目标：

\[
R(q,T)=
LCB[P_{\theta}(\text{success}\mid q,T)]
-\lambda_c\frac{\mathbb E[C]}{B_q}
-\lambda_l\frac{\mathbb E[L]}{SLA_q}
-\lambda_rCVaR_\alpha(\text{risk})
-\lambda_e\mathbb E[d_{\text{edit}}]
-\lambda_uU_\theta
\]

其中：

- `LCB` 是成功率的置信下界，而非均值；
- `CVaR` 对低概率高损失事件加重惩罚；
- `Uθ` 是 ensemble 方差、posterior variance 或 OOD score；
- 样本少的模板不能因为偶然成功一次就排名第一。

### 训练样本

正样本不是“执行成功过的模板”，而应是：

> 在同一任务、同一模型、近似相同预算下，相对其他候选具有较高 utility 的模板。

Hard negatives 应包括：

- 文本极相似但语言或工具不兼容；
- 图结构相似但缺 verifier；
- 历史成功率高但当前预算不够；
- 同 task family 下成功率显著低于最佳候选的模板。

这样可以避免 ranker 只学到“复杂模板/高成本模板通常更强”。

---

# 五、模板实例化

## 5.1 Typed slot

```text
SlotSpec {
    name
    type
    required
    resolver
    default
    validator
    allowed_values
    taint/security_label
}
```

典型槽位：

- `repo_root: Path`
- `target_files: List[Path]`
- `language: Enum`
- `build_command: Command`
- `test_command: Command`
- `reproduction_command: Optional[Command]`
- `allowed_write_globs: List[Glob]`
- `max_fix_rounds: Int[0..N]`
- `worker_model: ModelRef`
- `reviewer_model: ModelRef`
- `token_budget: PositiveInt`

## 5.2 绑定顺序

1. **确定性解析器优先**：manifest、lockfile、CI config、LSP/AST、测试配置。
2. **类型统一与约束求解**：检查路径、命令、operator 输入输出。
3. **LLM 只处理语义模糊槽位**，且只能返回结构化值。
4. 对 LLM 返回值运行 validator。
5. required slot 未解析：
   - 拒绝该模板；
   - 不能用任意字符串或幻觉值填补。
6. optional slot 未解析：
   - 使用安全默认值；
   - 或删除依赖该槽位的 optional subgraph。
7. 编译为 executable graph 后再次运行全图验证。

任务文本、issue 内容、网页内容应作为 **tainted data node** 传递，避免被直接拼接成系统级控制指令。

---

# 六、Graph Edit Action Space

## 6.1 最小完备原子动作

```text
BIND_SLOT(slot, value)

SET_PARAM(
    node,
    key,
    value
)  # prompt/model/tool/temperature/budget/role/guard

ADD_NODE(
    operator_type,
    typed_ports,
    attributes
)

DELETE_NODE(
    node,
    bypass_mapping
)

ADD_EDGE(
    src_node.src_port,
    dst_node.dst_port,
    edge_type
)

DELETE_EDGE(edge)

REDIRECT_EDGE(
    edge,
    new_src_or_dst
)

REPLACE_OPERATOR(
    node,
    compatible_operator
)
```

理论上，`ADD/DELETE node + ADD/DELETE edge + SET_PARAM` 已具有较强表达能力；但直接让策略生成这些原子动作，搜索空间太大且容易生成非法中间状态。

---

## 6.2 MVP 应暴露安全宏动作

```text
INSERT_VERIFIER(target)
INSERT_TESTER(target)
INSERT_REVIEWER(target)

PARALLELIZE(subgraph_a, subgraph_b)
ADD_AGGREGATOR(inputs, strategy)
ADD_BOUNDED_RETRY(region, max_rounds, stop_condition)

PRUNE_BRANCH(branch)
SHARE_OR_MEMOIZE(pure_subgraph)
SWITCH_MODEL(node, model)
SWITCH_TOOL(node, tool)
ADJUST_BUDGET(node_or_region, delta)

WRAP_SANDBOX(region)
ADD_GUARD(region, predicate)
```

这些宏动作内部展开为多个原子编辑，并保证：

- 有效端口连接；
- fan-out/fan-in 配对；
- bounded loop；
- 删除节点时正确重连；
- risk-tier 所要求的 verifier 不会被移除。

---

## 6.3 图合法性不变量

每次 edit 后必须满足：

1. 唯一入口与合法终止节点。
2. required input 全部可达。
3. 不存在 dangling edge、孤立执行节点。
4. 普通数据依赖是 DAG。
5. cycle 只允许出现在显式 `BoundedLoopRegion`。
6. 每个 loop 必须有：
   - `max_iterations`；
   - stop predicate；
   - cost budget；
   - no-progress termination。
7. effectful node 保持依赖顺序。
8. secret/PII 不流向无权限节点。
9. 所有 node/operator/model/tool 有确定版本。
10. 总预算、并发数和关键路径上界不超限。
11. 高风险任务的 mandatory verifier/human gate 不可被删除。
12. 图可 canonicalize 并生成稳定 content hash。

Canonicalization 应执行：

```text
remove unreachable nodes
→ normalize structured loops/guards
→ sort commutative parallel branches
→ collapse no-op nodes
→ normalize IDs
→ hash(operator version + params + incoming typed edges)
```

---

# 七、搜索、采样与学习方案

## 7.1 MVP：受约束局部 Beam Search

推荐：

```text
retrieve top 20
→ rank top 5 templates
→ instantiate
→ enumerate safe edit macros, depth ≤ 2
→ static validate
→ surrogate score
→ execute at most top 1–2 candidates
```

编辑距离约束：

\[
d(G,T)\le K,\qquad K=1\text{ 或 }2\text{ 起步}
\]

优点：

- 可解释；
- 容易做 action ablation；
- 易保证合法性；
- 不需要大规模在线探索；
- 失败时可准确回到原模板。

## 7.2 第二阶段：Contextual Bandit

状态：

```text
(task card, template card, edit macro, model/runtime version)
```

动作：

```text
choose template + one edit macro
```

回报：

```text
success - cost - latency - risk
```

使用受限 Thompson Sampling/UCB，仅在低风险任务上保留少量探索；所有 exploration propensity 必须记录，便于后续偏差校正。

## 7.3 第三阶段：学习式 Editor

数据足够后再训练：

1. 对成功的 edit traces 做 behavior cloning；
2. 用同任务、预算匹配的 winner/loser 做 pairwise preference learning；
3. 通过 action masking 保证只产生合法动作；
4. 最后才考虑 conservative offline RL 或受约束在线 RL。

不建议 MVP 直接采用 FlowReasoner 式“自由生成完整 workflow code + 多轮执行搜索”，因为其效果依赖可靠 query-level validation oracle，而真实 coding issue 经常没有这个条件。citeturn4view0turn3view1

---

# 八、风险约束与回退

## 8.1 四层保护

### A. 检索前

- policy/tool/permission filter；
- template version 和 provenance 检查；
- 禁用有历史安全事件的模板版本。

### B. 执行前

- graph compiler/type checker；
- budget analyzer；
- secret/data-flow analyzer；
- worktree/sandbox；
- dry-run 或 plan-only；
- validator 与 champion 比较。

### C. 执行中

Kill conditions：

- token、时间或调用数超过阈值；
- 连续产生相同错误；
- verifier 指标不再改善；
- loop 达到上限；
- 越权文件写入；
- 网络/凭证违规；
- 输出 schema 或 graph invariant 被破坏。

### D. 执行后

- rollback workspace/checkpoint；
- 保留完整 trace；
- 不将失败 candidate 自动写回 champion；
- 更新 failure signature，但不立即永久删除模板。

---

## 8.2 回退阶梯

```text
Edited retrieved graph
    ↓ validation/runtime failure
Unedited retrieved champion
    ↓ incompatible/failure
Safe generic task-family template
    ↓ failure
Single-agent conservative baseline
    ↓ high-risk or repeated failure
Human escalation
```

对带外部副作用的任务：

- 必须使用 idempotency key、dry-run 或补偿动作；
- 如果无法证明可回滚，不允许自动切换并重放另一个 workflow。

---

## 8.3 Champion–Challenger

模板更新必须是版本化的：

```text
champion/v17
challenger/v18
```

只有同时满足以下条件才晋升：

- held-out task utility 的置信下界优于 champion；
- 成本比较是预算匹配的；
- 没有新增 hard safety violation；
- OOD/task-family holdout 没有明显退化；
- fallback rate 没有异常升高。

---

# 九、Cold-start Baseline

## 9.1 库为空

至少提供以下种子模板：

### T0：Direct

```text
Inspect → Implement → Test
```

### T1：Safe Generic

```text
Inspect
→ Plan
→ Implement
→ Test
→ BoundedFix(max=2)
→ Review
```

### T2：Bugfix

```text
Reproduce
→ Localize
→ Patch
→ RegressionTest
→ Review
```

### T3：Complex/Multi-file

```text
ParallelExplore
→ AggregatePlan
→ Implement
→ Test
→ Review
```

其中 **T1 是真正的 cold-start 基准**。T0–T3 由确定性规则路由：

- 有 failing test/repro → T2；
- change surface 大、跨模块 → T3；
- 简单文档/config/小改动 → T0；
- 其他 → T1。

此阶段：

- 不用 learned reranker；
- 不让 LLM 自由设计任意拓扑；
- success posterior 使用保守先验；
- 只允许规则编辑和 bounded loop。

## 9.2 少量数据

- BM25 + metadata 检索；
- Beta-Binomial 或其他简单经验后验；
- 只训练 template compatibility classifier；
- 保留低风险、预算受控的随机探索。

## 9.3 数据成熟

再依次启用：

1. dense retriever；
2. cross-encoder reranker；
3. utility/cost/risk surrogate；
4. edit macro policy；
5. conservative online adaptation。

---

# 十、MVP 算法伪代码

```python
def solve(task, repo, policy, budget):
    # 1. 编译任务
    q = build_task_card(
        task=task,
        repo=repo,
        policy=policy,
        budget=budget,
    )

    # 2. 用元数据索引执行不可放宽的硬过滤
    feasible_pool = template_index.hard_filter(
        language=q.language,
        framework=q.framework,
        allowed_tools=q.allowed_tools,
        allowed_models=q.allowed_models,
        permissions=q.permissions,
        risk_tier=q.risk_tier,
        budget=q.budget,
    )

    # 3. 冷启动
    if not feasible_pool:
        feasible_pool = safe_seed_portfolio(q.task_family)

    # 4. 混合召回
    candidates = union(
        bm25_retrieve(q, feasible_pool, k=20),
        dense_retrieve(q, feasible_pool, k=20),
        graph_signature_retrieve(q.requirement_graph,
                                 feasible_pool, k=20),
        exact_metadata_retrieve(q, feasible_pool),
    )

    # 5. 再次执行硬约束，避免近似索引误召回
    candidates = [
        t for t in candidates
        if hard_constraints_hold(q, t)
    ]

    # 6. 模板排序
    ranked = rank_by_risk_adjusted_utility(q, candidates)

    graphs = []
    for template in ranked[:5]:
        bindings = resolve_typed_slots(q, repo, template)

        if bindings.has_unresolved_required_slots:
            continue

        base_graph = instantiate(template, bindings)

        if not static_validate(base_graph, q.policy, q.budget):
            continue

        # 未编辑模板本身也必须作为候选
        graphs.append(base_graph)

        # 7. 局部安全编辑，深度最多 2
        for edit_sequence in enumerate_safe_macro_edits(
            q,
            base_graph,
            max_depth=2,
        ):
            edited = apply_edits(base_graph, edit_sequence)
            edited = canonicalize(edited)

            if static_validate(edited, q.policy, q.budget):
                graphs.append(edited)

    # 8. Surrogate 排序
    scored = [
        (
            risk_adjusted_score(q, g),
            uncertainty(q, g),
            g,
        )
        for g in graphs
    ]
    scored.sort(reverse=True)

    champion = best_unedited_safe_graph(ranked, q)
    challenger = scored[0].graph if scored else champion

    # 置信度或改进 margin 不够时不探索
    if (
        scored[0].uncertainty > q.max_uncertainty
        or scored[0].score < predicted_score(q, champion) + q.min_margin
    ):
        challenger = champion

    # 9. 沙箱执行
    result = execute_with_guards(
        graph=challenger,
        sandbox=ephemeral_worktree(repo),
        budgets=q.budget,
        kill_conditions=default_kill_conditions(q),
    )

    # 10. 回退
    if result.guard_violation or result.invalid or result.no_progress:
        rollback(result.checkpoint)

        if challenger.content_hash != champion.content_hash:
            result = execute_with_guards(
                graph=champion,
                sandbox=ephemeral_worktree(repo),
                budgets=remaining_safe_budget(q),
                kill_conditions=default_kill_conditions(q),
            )

    # 11. 记录完整选择上下文
    log_execution(
        task_card=q,
        candidate_set=candidates,
        selected_template=challenger.template_id,
        graph_version=challenger.content_hash,
        edit_sequence=challenger.edit_sequence,
        selection_propensity=challenger.propensity,
        outcome=result,
    )

    return result
```

---

# 十一、训练协议

## 11.1 数据记录

每条训练记录至少包含：

```text
task_id/repo_id/task_timestamp
task_card
available candidate set
template ID/version
slot bindings
edit sequence
selection propensity
model/tool/runtime versions
static validation result
success/failure
token/cost/latency
fallback and safety events
final evaluator result
```

## 11.2 Split

必须同时做：

1. **Repo-group split**：同一 repo 不跨 train/test。
2. **Chronological split**：未来任务和未来模板版本不能泄漏到训练。
3. **Task-family holdout**：单独测试 bugfix、feature、refactor 等迁移。
4. **模型/runtime version holdout**：检测模板是否绑定某个特定模型版本。
5. test split 的模板库必须仅由 train traces 构建。

## 11.3 Retriever 训练

正例：

- 同一任务候选中，hard feasible 且 utility 接近最优的模板。

负例：

- infeasible；
- 成本超限；
- 语义相似但执行失败；
- 同任务下明显劣于其他候选。

## 11.4 Ranker 训练

使用同任务 pairwise/listwise 数据：

```text
(q, candidate_A, candidate_B, A_better_than_B)
```

只比较：

- 同一 worker/model；
- 近似相同 token/cost budget；
- 相同 evaluator；
- 相同或可校正的随机种子设置。

## 11.5 Editor 训练

标签应是：

\[
\Delta U =
U(G_{\text{edited}})
-
U(G_{\text{base}})
\]

而不是单独看 edited graph 是否成功，否则 editor 会把模板本身的强弱误当成编辑贡献。

---

# 十二、离线与端到端评估

SWE-bench 官方任务来自真实 GitHub issue，并使用可复现的 Docker evaluation harness；当前站点包含 65 个 repository、3,489 个 task instance，并支持 resolved rate、cost 等比较，适合作为 WS7 的端到端测试底座。citeturn2view0

## 12.1 Retrieval

- Feasible Recall@K；
- Near-optimal Recall@K；
- nDCG@K，以真实 utility 为 relevance；
- Oracle regret：

\[
Regret@K =
U(T^*)
-
\max_{T\in TopK}U(T)
\]

## 12.2 实例化与约束

- required slot resolution rate；
- compile success rate；
- graph validity rate；
- hard constraint false-accept rate；
- unsupported tool/model invocation rate。

安全硬约束的 false accept 目标应为 **0**。

## 12.3 Graph editing

- valid edit rate；
- 平均 edit distance；
- `P(ΔU>0)`；
- 平均/中位数 `ΔU`；
- edit-induced failure rate；
- editor 与 unedited template 的 paired comparison。

## 12.4 End-to-end

- resolved/pass rate；
- token、美元成本、wall-clock；
- critical-path latency；
- tool/LLM call 数；
- fallback rate；
- timeout/no-progress rate；
- safety incidents；
- utility Pareto frontier。

## 12.5 基线与消融

至少比较：

1. 固定 Safe Generic graph；
2. 规则路由种子模板；
3. BM25 retrieval、无编辑；
4. dense retrieval、无编辑；
5. hybrid retrieval、无 reranker；
6. hybrid + learned reranker、无编辑；
7. hybrid + rule edits；
8. hybrid + learned local edits；
9. oracle template upper bound。

关键消融：

- 去掉 hard filter；
- 去掉 graph signature；
- 去掉 performance posterior；
- 去掉 uncertainty penalty；
- 去掉 edit distance penalty；
- 无 champion fallback；
- 任意自由编辑 vs 安全宏编辑。

统计上使用 task-level paired bootstrap，并对同一 repo 内任务进行 cluster-aware 处理；成功率可配合 McNemar/permutation test，连续成本指标报告置信区间，而不只报告均值。

---

# 十三、最危险的评测泄漏

1. 从 test tasks 的执行轨迹蒸馏模板，再评估同一 test split。
2. 当前任务隐藏测试 pass rate 被放入 retrieval/ranking key。
3. FlowReasoner 式 per-query workflow search 使用最终 evaluator tests，而不是单独的开发验证 oracle。
4. 同一 repo 或相似 issue 跨 split。
5. learned ranker 通过模板版本时间间接看到未来信息。
6. 高成本模板获得更多重试，却与低成本 baseline 直接比较成功率。
7. editor 只在强模板上执行，导致把模板选择优势误认为 edit 优势。
8. 没有记录 selection propensity，却对日志数据直接使用 IPS/off-policy estimator。

因此，**如果没有已知 propensity 和足够 action support，不应把纯日志 IPS/replay 当作主要结论；预算匹配的离线候选执行矩阵和小比例安全随机实验更可靠。**

---

# 十四、最终推荐架构

```text
Task/Repo
   │
   ▼
TaskCard Compiler
   │
   ▼
Hard Metadata/Policy Filter
   │
   ▼
BM25 + Dense + Metadata + Graph-signature Retrieval
   │
   ▼
Risk-adjusted Learned Reranker
   │
   ▼
Typed Slot Binding + Template Compilation
   │
   ▼
Bounded Safe-Macro Graph Editing
   │
   ▼
Static Type/Policy/Budget Validation
   │
   ▼
Surrogate Selection with Uncertainty Gate
   │
   ├──────── low confidence ────────▶ Champion
   ▼
Sandbox/Canary Execution
   │
   ├──────── violation/failure ─────▶ Rollback → Champion
   ▼
Trace + Outcome + Propensity Logging
   │
   ▼
Offline Retriever/Ranker/Editor Update
   │
   ▼
Held-out Gate → Template Version Promotion
```

**一句话定案：**

> WS7 的 MVP 应是“案例检索系统 + 图编译器 + 小半径结构搜索”，而不是“让 LLM/RL 每个任务从零自由生成一张 agent graph”。MaAS、GPTSwarm、FlowReasoner 分别提供了 query-conditioned routing、概率边优化和 query-level workflow generation 的有力局部先例，但没有任何一篇单独解决了大型 Workflow IR 库的检索、类型安全实例化、局部编辑与可靠回退。
