# 并行攻关 A：WS0 + WS5 可落地设计报告

> 研究日期：2026-07-13  
> 范围：无重跑 credit assignment、度量体系、跨运行结构性冗余  
> 约束：不修改原文；以下内容可直接并入设计文档  
> 状态说明：算法与门槛属于**待实验验证的工程方案**；文献事实另行标注核验状态

---

## 1. 结论摘要

1. **单次 trace 无法无假设地识别真正的因果边际贡献。**一次运行只观察到了“节点存在”这一事实，无法同时观察同一随机条件下“节点不存在”的反事实。因此，trace-only 方法必须称为 **contribution proxy / removal-risk estimator**，不能在未经 LOO 校准前直接称为 causal credit。citeturn10search0
2. 推荐实现两层归因：
   - **算法 A：验证约束的溯源反向传播 PVF**，基于真实消费关系、代码变更、工具副作用和测试证据，冷启动即可运行；
   - **算法 B：图反事实 Critic GCC**，用少量 LOO 数据学习 `P(移除该节点会伤害结果 | 单次 trace)`。
3. **不要把“被读取”直接等同于“有贡献”**。Trace 中至少区分：
   - output 被传递；
   - output 被读取；
   - output 被下游派生结果使用；
   - output 最终到达并影响可验证终点。
4. DyLAN 的 successor rating + 反向传播是目前最接近 single-trace 归因的直接先例；但它的 rating 是模型自评，只做了较小规模的 Shapley 对照，不能直接作为 coding-agent 的因果真值。citeturn1view0
5. 2026 年的 removal-based attribution 工作表明：
   - LOO 在其测试设置中能以远低于组合式 Shapley 的成本找到低贡献节点；
   - “让 LLM 想象某 agent 不存在”的 introspective removal，在层级拓扑中可能与真实 ablation 严重不一致。故**不得只靠 LLM judge 自动删节点**。citeturn0search3
6. 跨运行“结构性冗余”必须是**条件化结论**：某角色可能在简单修复中冗余，在跨模块、安全或迁移任务中必要。默认应学习 `P(harm | workflow slot, task context)`，而不是给角色一个永久全局分数。
7. MVP 不应直接重写 IR。建议顺序为：
   **观测 → shadow ranking → lazy skip + fallback → canary → template hard prune**。

---

## 2. 核心文献与编号核验

| 文献 | 核验结果 | 对本项目真正有用的部分 | 不能误读之处 |
|---|---|---|---|
| **DyLAN**, arXiv:`2310.02170`，正式题名 *A Dynamic LLM-Powered Agent Network for Task-Oriented Agent Collaboration* | **已核验**；COLM 2024 | 下游 agent 对前驱答案评分，再沿时间图反向传播 Agent Importance Score；最接近 trace-only credit | 评分来自 LLM successor，而非真实删除实验；其 Shapley 对照规模较小，不足以证明普遍因果可靠性。citeturn1view0 |
| **AgentPrune / Cut the Crap**, arXiv:`2410.02506` | **已核验** | 将 MAS 表示为空间—时间通信图，学习边 mask，然后做 magnitude pruning | 这里的 “one-shot pruning” 指 mask 优化后的单次剪枝，不等于“仅凭一条 trace 无重跑归因”；优化期间仍需要 utility evaluation。citeturn0search1 |
| **Adaptive Graph Pruning**, arXiv:`2506.02951` | **已核验** | 两阶段收集较优拓扑，再训练模型按任务同时预测 node hard-pruning 和 edge soft-pruning | 是跨任务学习的 topology selector，不是单次运行后的因果归因器；可作为后续 GCC/conditional gate 的架构参考。citeturn0search2 |
| **Agents that Matter**, arXiv:`2605.27621` | **编号已确认，不再“存疑”**；2026-05-26 v1 | 把 attribution 分解为 coalition distribution、removal protocol、target metric；实验中 LOO 的 deletion ranking 接近组合式方法；明确展示 introspective removal 的失真 | 新近预印本，尚需更多拓扑和 coding-agent 环境复现；其结果不能自动外推到动态 workflow。citeturn0search3 |
| **IntrospecLOO**, arXiv:`2505.22192` | **已核验** | 不完全重跑辩论，只追加忽略指定 agent 的反思轮，可作为便宜 baseline | 后续更系统的研究发现它并不总能逼近真实 ablation，尤其不能作为 hard-prune 唯一证据。citeturn2search0turn0search3 |

### 额外工程依据

- Trace schema 可复用 OpenTelemetry 的 span/event/attribute/link 模型，但父子 span 不足以表达共享产物，应增加显式 artifact/use/derive 关系。OpenTelemetry 的 links 可表达非严格父子关联；W3C PROV 则明确区分 Entity、Activity、Usage 和 Derivation。citeturn8search0turn8search1turn8search2
- Attention、模型自报“我用了哪个输入”等信号只能作为弱证据；已有 NLP 实验表明 attention 权重不必然构成忠实解释。citeturn9view0
- **摘要级核验、尚未核字段**：2026 年已出现 TraceLab、CodeTraceBench 等 coding-agent trace 数据资源，因此原文“完全没有公开轨迹数据”的表述需要弱化；但公开摘要尚不能确认其是否同时包含完整 sub-agent 图、consumer 关系、逐节点 token 和 artifact provenance，自采 trace 仍然必要。citeturn14search1turn14search2

---

## 3. 统一问题定义

令一次执行 trace 为：

\[
\tau=(G,A,R,Z,C,X)
\]

其中：

- \(G=(V,E)\)：时间展开后的执行 DAG；环必须按迭代展开，或先压缩成 SCC；
- \(A_i=\{a_{i1},\ldots\}\)：节点 \(i\) 输出的原子产物，如 claim、计划步骤、代码 hunk、命令结果、测试证据；
- \(R\)：产物间的 use/derive/validate/overwrite 关系；
- \(Z\)：最终 diff、最终答案、测试和 verifier 等终点证据；
- \(C_i\)：节点 token、美元成本、运行时间和关键路径占用；
- \(X\)：任务、仓库、模型、角色和拓扑上下文。

真实 LOO 贡献定义为：

\[
\Delta_i^Q =
\mathbb E_{\xi}
\left[
Q(\tau_{\text{full},\xi})-
Q(\tau_{-i,\xi})
\right]
\]

其中正值表示移除节点会降低质量，即节点有价值。Single-trace 算法只能输出：

\[
\widehat{\Delta}_i,\qquad
p_i^{harm}
=
P(\Delta_i^Q>\epsilon_Q\mid \tau)
\]

推荐把最终剪枝决策表述为：

\[
\text{Prune}(i)
=
\mathbf 1
\left[
UCB_{95\%}(p_i^{harm})<\alpha
\land
LCB_{95\%}(\text{saving}_i)>s_{\min}
\right]
\]

不要过早把质量、token、延迟和美元成本压成一个任意加权总分。安全门先做**质量非劣约束**，再最大化成本节省。

---

# 4. 算法 A：PVF——验证约束的溯源反向传播

## 4.1 输入

每个节点必须记录：

```text
node_id, role, task_signature
input_artifact_ids[]
output_atoms[]:
  atom_id, type, text_or_hash
  file/path/hunk/command/test identifiers
consumption_events[]:
  source_atom_id, consumer_node_id
  relation = read | quote | derive | validate | overwrite | side_effect
retained_in_final
cost:
  input_tokens, output_tokens, dollars, wall_time, critical_path_time
```

建议下游 agent 在正常响应中附带结构化 receipt：

```json
{
  "used_inputs": [
    {
      "source_node": "n12",
      "atom_ids": ["a12.2"],
      "mode": "constraint",
      "necessity": 0.8,
      "valence": 1,
      "confidence": 0.7
    }
  ]
}
```

Receipt 必须引用实际 artifact ID；无法与 prompt、代码 hunk 或工具事件对齐的自报信息降权或丢弃。

## 4.2 边权

对产物 \(a\rightarrow b\) 定义：

\[
w_{ab}
=
\theta_{\text{relation}}
\cdot q_{\text{match}}
\cdot q_{\text{receipt}}
\]

MVP 可采用以下**待 LOO 校准的保守初值**：

| 证据 | 初始权重 |
|---|---:|
| 明确代码 hunk、文件写入或工具副作用依赖 | 1.0 |
| 下游显式引用 artifact ID | 0.9 |
| 精确文本/结构复用 | 0.8 |
| Receipt 声称使用且能定位对应内容 | 0.6 |
| 仅语义相似 | 0.2 |
| 仅 attention 或无证据自评 | 不超过 0.1 |

每个下游产物还增加一个 `SELF` 来源，表示其自行产生而非来自任何前驱。

## 4.3 反向传播公式

给终点产物设置有符号 utility anchor \(u(a)\)：

- 最终保留且通过验证的产物：正值；
- 被回滚、被 verifier 否决或直接导致失败的产物：负值；
- 无验证证据：0。

按逆拓扑序：

\[
Credit(a)
=
u(a)
+
\sum_{b\in Succ(a)}
Credit(b)
\frac{w_{ab}}
{w_{\text{self},b}+\sum_{a'\in Pred(b)}|w_{a'b}|}
\]

节点归因：

\[
Credit_i=\sum_{a\in A_i}Credit(a)
\]

成本效率：

\[
Density_i=
\frac{\max(Credit_i,0)}
{\text{tokens}_i+\lambda\,\text{critical\_path\_ms}_i}
\]

其中 `Density` 只用于排序；实际决策仍使用校准后的 \(p_i^{harm}\)。

## 4.4 伪代码

```python
def pvf(trace):
    atoms, relations = build_provenance_graph(trace)
    credit = {a: terminal_anchor(a, trace) for a in atoms}

    for b in reverse_topological_order(atoms):
        incoming = relations.incoming(b)
        denom = self_weight(b) + sum(abs(e.weight) for e in incoming)

        if denom == 0:
            continue

        for e in incoming:
            credit[e.source] += credit[b] * e.weight / denom

    node_credit = {}
    for node in trace.nodes:
        node_credit[node.id] = sum(credit[a] for a in node.output_atoms)

    return node_credit
```

## 4.5 复杂度

- 有显式 artifact IDs：时间和空间均为 \(O(|A|+|R|)\)；
- 需要语义匹配时：
  - 暴力匹配可能接近二次复杂度；
  - 使用 embedding/ANN 后约为 \(O(|A|\log |A|+K)\)；
- 逆向传播本身为线性复杂度。

## 4.6 失败模式

1. **隐式启发未留下可观察引用**：前驱只改变了下游思路，未复制文本，容易假阴性。
2. **被读取但被忽略**：只记录 prompt 包含关系会造成假阳性。
3. **公共来源混淆**：两个 agent 都从同一文件得到相同结论，语义相似不代表相互贡献。
4. **未记录副作用**：节点修改文件、环境变量或缓存但没有 artifact ID，会被误判为零贡献。
5. **协同效应**：两个节点单独弱、组合强，线性分摊无法恢复交互项。
6. **失败任务缺少正终点**：所有 credit 可能接近零；此时只能分析“到达最终尝试的影响”，不能判断正确贡献。
7. **环和重试**：必须按轮次展开，否则会出现循环归因。

---

# 5. 算法 B：GCC——单 trace 图反事实 Critic

PVF 是可解释的规则代理，但会漏掉隐式影响。GCC 用少量 LOO 重跑训练一个预测器，在新任务上仅使用一条 trace。

## 5.1 输入特征

每个节点包括：

- role、prompt/template ID、模型和工具能力；
- 输入/输出 embedding；
- 入度、出度、深度、是否在关键路径；
- PVF score、consumer coverage、receipt 特征；
- token、延迟、是否产生持久副作用；
- 任务类型、仓库、语言、任务难度；
- 最终执行结果和 verifier 证据。

## 5.2 模型与输出

使用 GraphSAGE/GAT/Graph Transformer 或冷启动时的 GBDT：

\[
H=\operatorname{GraphEncoder}_\phi(G,X)
\]

对每个节点一次性输出：

\[
(\hat\mu_i,\hat\sigma_i)
=
Head_\phi(H_i,\operatorname{Pool}(H),C_i)
\]

其中：

- \(\hat\mu_i\)：预测 LOO 质量损失；
- \(\hat\sigma_i\)：预测不确定性。

若假设条件分布近似正态：

\[
p_i^{harm}
=
\Phi\left(
\frac{\hat\mu_i-\epsilon_Q}{\hat\sigma_i}
\right)
\]

训练目标：

\[
\mathcal L=
\sum_{(r,i)\in D_{LOO}}
\left[
\frac{(\Delta_{ri}-\hat\mu_{ri})^2}{2\hat\sigma_{ri}^2}
+\log\hat\sigma_{ri}
\right]
+\lambda_1\mathcal L_{\text{rank}}
+\lambda_2\mathcal L_{\text{Brier}}
\]

`rank loss` 保证重要节点排序；Brier loss 校准 `harm probability`。

## 5.3 伪代码

```python
def train_gcc(full_traces, loo_pairs):
    features = encode_trace_features(full_traces)
    model = GraphCritic()

    for trace, node_id, observed_delta in loo_pairs:
        mu, sigma = model(features[trace])[node_id]
        loss = gaussian_nll(observed_delta, mu, sigma)
        loss += rank_loss(model, trace)
        loss += brier_loss(model, trace, node_id, observed_delta)
        optimize(loss)

    calibrator = fit_isotonic_or_conformal(model, heldout_loo_pairs)
    return model, calibrator


def infer_gcc(trace, model, calibrator):
    mu, sigma = model(encode_trace_features(trace))
    return calibrator.to_harm_probabilities(mu, sigma)
```

## 5.4 复杂度

- 普通消息传递 GNN：约 \(O((|V|+|E|)d^2)\)；
- Graph Transformer：取决于 attention 结构，最坏可能为 \(O(|V|^2d)\)；
- 一次前向同时输出全部节点，无需每节点重跑 workflow。

## 5.5 失败模式

1. **任务/模型/拓扑分布漂移**；
2. LOO 标签集中于低分节点，产生选择偏差；
3. 仓库或模板泄漏导致虚假高分；
4. 小数据下不确定性估计过度自信；
5. 多节点协同导致单节点 LOO 不稳定；
6. 模型可能只学到“某角色通常贵”，而不是该次运行是否必要；
7. Orchestrator、router 等结构节点的删除改变系统可执行性，不能和普通 worker 共用标签定义。

**建议：GCC 的第一版先用可解释的 logistic regression/GBDT，证明有效后再升级图神经网络。**

---

# 6. 少量 LOO 校准实验

## 6.1 必须先固定 removal protocol

不同 intervention 回答不同问题，不应混为一个标签：

### A. Structural ablation

用于判断“这个节点是否可以从 workflow 删除”。

- 删除节点；
- 禁止复用它原运行中的输出；
- 对 outgoing edge 注入 typed `ABSENT`；
- 允许下游走预先定义的 fallback；
- required router/orchestrator 不使用该协议。

### B. Model replacement

用于判断“该角色是否可以降级到便宜模型”。

- 保留角色、拓扑、工具和输出接口；
- 只替换 backbone/model configuration。

两类标签必须分开存储。Removal-based attribution 的现有结果也说明 removal protocol 会显著改变 attribution 的语义。citeturn0search3

## 6.2 推荐初始预算

第一轮建议抽取 **96 个 node-task pair**，而不是遍历所有节点：

| 类别 | 数量 |
|---|---:|
| PVF/GCC 预测低贡献但高成本 | 40 |
| 两算法分歧或位于剪枝阈值附近 | 24 |
| 预测高贡献的正对照 | 12 |
| 随机抽样，防止选择偏差 | 12 |
| 人工构造空节点/重复节点负对照 | 8 |

分层覆盖：

- 成功任务与失败任务；
- 叶节点、fan-in 节点、verifier、tool agent；
- 不同仓库、语言、任务难度；
- 高/低 provenance coverage；
- 至少三种 workflow/template。

## 6.3 随机性控制

1. 固定代码仓库 snapshot、依赖、工具版本和模型配置；
2. 若 API 支持，使用相同 seed/common random numbers；
3. 缓存外部检索结果，但不得缓存被删除节点的输出；
4. 随机抽取 10–20 个任务进行 full-vs-full 重复运行，估计自然波动：

\[
\epsilon_Q
=
\max\left(
\epsilon_{\text{domain}},
Q_{0.95}
\left(
|Q_{\text{full}}^{(1)}-Q_{\text{full}}^{(2)}|
\right)
\right)
\]

阈值附近和高风险节点增加到 2–3 个重复 seed；明显冗余节点先只跑一次。

## 6.4 标签

定义：

\[
Y_i^{harm}
=
\mathbf 1[
Q_{\text{full}}-Q_{-i}>\epsilon_Q
]
\]

另外单独保存：

- `success_flip`：成功变失败；
- `new_regression`：产生新的测试失败；
- `test_fraction_delta`；
- `tokens_saved`；
- `critical_path_saved`；
- `fallback_triggered`；
- `non_executable_after_removal`。

## 6.5 校准方式

- PVF 原始分数使用 isotonic regression 或 Platt scaling 映射到 \(p_i^{harm}\)；
- GCC 使用 grouped 5-fold cross-validation；
- 所有 train/test split 必须按 **repository/task** 分组，不能随机按节点切分；
- 20% 完全留作最终 holdout；
- 第二轮 LOO 优先选择：
  1. 两算法分歧最大的节点；
  2. 预测置信区间最宽的节点；
  3. 最接近剪枝阈值的节点。

---

# 7. Metrics 与统计置信机制

## 7.1 单次 trace 指标

| 指标 | 定义 |
|---|---|
| **Consumer Coverage** | 被下游显式 use/derive 的 output atom 权重占比 |
| **Terminal Reachability** | 节点是否存在通往最终保留产物或验证终点的 provenance 路径 |
| **Provenance Coverage** | 最终产物中能够追溯到具体节点/SELF 的原子占比 |
| **Dead Cost Rate** | \(\sum_i C_i\mathbf1[\text{无终点路径}]/\sum_i C_i\) |
| **Low-risk Removable Cost** | \(\sum_i C_i\mathbf1[UCB(p_i^{harm})<\alpha]/\sum_i C_i\) |
| **Credit Density** | 正贡献除以 token 或关键路径耗时 |
| **Critical-path Waste** | 低贡献节点在关键路径上占用的时间比例 |
| **Untracked Mutation Rate** | 无来源节点 ID 的文件/状态修改比例；应为 0 |

## 7.2 与 LOO 的归因校准指标

- **AUPRC**：识别 critical/harmful-to-remove 节点的主指标；
- AUROC：辅助指标，不能代替 AUPRC；
- Spearman/Kendall：排序一致性；
- MAE/RMSE：连续 \(\Delta_i\) 预测；
- Brier score、ECE：风险概率校准；
- Top-k deletion curve / deletion AUC：依次移除低分节点后的质量曲线；该指标也被最新 removal-based attribution 工作用于比较归因方法。citeturn0search3
- Cost captured at fixed harm budget：在允许的质量风险下捕获了多少 token 成本。

## 7.3 系统指标

质量和效率必须同时报告：

- issue resolved/pass rate；
- 测试通过率、新增 regression 数；
- token、美元成本；
- wall-clock latency；
- critical-path latency；
- fallback rate；
- harmful-prune rate；
- 回滚率；
- 每成功任务 token；
- 质量—成本 Pareto 曲线。

## 7.4 统计置信

1. **Bootstrap 单位必须是 task/repository，不是 node。**同一任务内的节点高度相关。
2. 系统 A/B 使用 paired cluster bootstrap，报告差值的 95% CI。
3. 对实际 LOO/canary 的 harmful event 使用：

\[
p_{s,k}\sim
Beta(0.5+H_{s,k},\,0.5+N_{s,k}-H_{s,k})
\]

这里 \(H\) 必须来自真实 LOO/canary；**不能把预测分数当成真实 Bernoulli 观测**。
4. 长期 canary 持续查看数据时，使用 anytime-valid confidence sequence，避免反复查看普通 CI 导致假阳性膨胀。citeturn11search0
5. 采用质量非劣检验：
   - 主条件：质量差的 95% CI 下界高于 \(-\epsilon_Q\)；
   - 次条件：token saving 的 95% CI 下界高于目标值。

---

# 8. 跨运行“结构性冗余”定义

## 8.1 Slot key

不要仅按角色名称聚合。建议定义：

```text
slot_key = hash(
  workflow_template_id,
  node_role,
  prompt_schema_version,
  tool_capabilities,
  predecessor_types,
  output_contract
)
```

上下文分层：

```text
task_stratum = (
  task_type,
  repository/domain,
  language,
  difficulty_bucket,
  changed_file_count,
  security_or_migration_flag
)
```

## 8.2 条件化结构冗余

\[
Criticality(s,k)
=
P(\Delta_i^Q>\epsilon_Q
\mid slot=s,\ stratum=k)
\]

\[
StructuralRedundancy(s,k)
=
1-Criticality(s,k)
\]

成本质量：

\[
ExpectedWaste(s,k)
=
\mathbb E[
C_i\cdot
\mathbf1(\Delta_i^Q\le\epsilon_Q)
\mid s,k
]
\]

只有同时满足以下条件才是**结构性冗余候选**：

1. 在目标 task stratum 中经常出现；
2. 低贡献结果跨多个任务、仓库和 seed 重复；
3. 节点成本显著；
4. 不是由于 instrumentation 缺失造成的假零；
5. 实际 LOO/canary 的 harm 上界低于门槛。

如果某 slot 只在部分任务中有用，应学习 conditional gate，而不是从模板永久删除。

---

# 9. 建议门槛

以下为**工程起始门槛，不是已被论文证明的常数**。

| 阶段 | 门槛 |
|---|---|
| Attribution 数据可用 | 最终 artifact provenance coverage ≥ 70%；untracked mutation = 0 |
| 进入 shadow ranking | grouped holdout 上 Spearman ≥ 0.5；critical-node AUPRC ≥ 0.75；ECE ≤ 0.08 |
| Lazy skip + fallback | 候选节点 \(UCB_{95\%}(p^{harm})<5\%\)；预计 token saving ≥ 5% |
| Canary 自动跳过 | 系统质量差 95% CI 下界 ≥ −1 percentage point；token saving 95% CI 下界 ≥ 10%；无新增严重 regression |
| Template hard prune | 每个主要 task stratum 的 harm-rate 95% 上界 < 2%，且连续 canary 无回退异常 |
| 无法满足 hard-prune 样本量 | 保持 lazy gate 和运行时 fallback，不做物理删除 |

稀有风险的统计要求很高：若没有分层池化或强先验，零事故情况下要把 95% 风险上界压到约 5% 通常需要约 60 个样本；压到约 2% 需要约 150 个样本。因此“少量 LOO”适合**校准和筛选**，不能单独证明永久删除绝对安全。

---

# 10. MVP 与后续版本决策

## MVP：建议立即实施

### 必做

1. 时间展开执行 DAG；
2. artifact ID 和 output atom；
3. consumer/use/derive/validate/overwrite 事件；
4. 文件、命令、测试、缓存等副作用 provenance；
5. retained/rolled-back 状态；
6. 节点 token、美元、wall time、critical-path time；
7. PVF；
8. 96 个左右的分层 LOO 校准；
9. logistic/GBDT 风险校准器；
10. shadow dashboard。

### MVP 只允许

- 展示 dead cost；
- 生成候选节点列表；
- lazy skip；
- 缺失产物被请求时自动恢复执行；
- 版本化、可回滚的 IR patch 建议。

### MVP 禁止

- 仅凭 attention 删节点；
- 仅凭 LLM judge 自报删节点；
- 单次零分后永久删除；
- 将失败任务中的零 credit 直接解释为节点无价值；
- 不区分 ablation 和 model replacement；
- 自动删除 orchestrator、final verifier、安全检查和有持久副作用的节点。

## v1

- GCC 图 Critic；
- active LOO sampling；
- context-conditional gate；
- paired canary 与顺序置信区间；
- interaction audit：对高频节点对做少量 pairwise LOO；
- model replacement attribution，用于模型降级而非删角色。

## v2

- hierarchical Bayesian criticality model；
- 跨模型、跨仓库迁移校准；
- DAG-aware coalition audit；
- 自动生成 IR patch，但仍需 canary；
- 仅对证据充分的 slot 进行物理 hard prune。

---

## 11. 最终建议

**最可落地的技术路线不是“从一条 trace 直接算出真实 Shapley”，而是：**

\[
\boxed{
\text{显式 provenance}
+
\text{验证终点反向传播}
+
\text{少量真实 LOO 校准}
+
\text{跨任务条件化风险估计}
+
\text{lazy fallback}
}
\]

项目的核心创新点应表述为：

> 构建一种面向 coding-agent 执行图的、经稀疏干预校准的 single-trace credit estimator；它不声称从观测轨迹恢复无假设因果效应，而是在明确 removal protocol、可验证 artifact provenance 和统计风险门槛下，预测节点移除风险，并以跨运行证据驱动安全的 workflow IR 演化。

这比宣称“无重跑得到真实因果归因”更严谨，也更容易形成可复现、可发表的技术贡献。
