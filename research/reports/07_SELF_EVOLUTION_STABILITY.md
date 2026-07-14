# WS8：自进化闭环稳定性——Champion-Gated Evolution

> **核验日期：2026-07-13**  
> **目标：**让 Workflow IR 可以持续产生候选、试验和升级，同时限制退化、漂移、遗忘与线上探索损失。  
> **结论性质：**本文给出的是**有界风险的工程协议**，不是“每轮必然变好”的数学保证。文中数值均为 MVP 起始门槛，必须用本项目数据重新校准。

---

## 1. 结论先行

1. **不要原地修改唯一 workflow。**采用不可变 `archive + champion pointer + challenger lifecycle`；所有候选均保留 lineage、评测证据和可回滚制品。
2. **“进化”与“发布”彻底解耦。**搜索器可以产生退化候选；只有通过盲化的 paired held-out gate、shadow 和 canary 的候选才能成为 champion。
3. **按 task stratum 维护 champion，而非一个全局 champion。**例如 bugfix、跨模块修改、安全任务、语言/框架、预算档位分别有 champion；否则平均收益会掩盖局部灾难性遗忘。
4. **Promotion 使用非劣门 + 改进门：**先证明质量未劣化，再证明成本、时延或综合效用至少一项有实际改善；证据不足就是 `INCONCLUSIVE`，不能当作通过。
5. **持续监控必须使用 anytime-valid 方法。**普通固定样本 p 值不能在 canary 中被反复查看；采用 confidence sequence/e-process 或预先固定检查点。
6. **探索遵守 conservative budget：**任何时刻 challenger 的累计可归因损失都不得耗尽预算；高风险或不可逆副作用任务默认不做自动线上探索。
7. **Rollback 是发布前置条件。**不能在规定时间内完整恢复 workflow、模型/提示、工具、策略、缓存/Schema 版本的候选，禁止进入 canary。
8. **最多只能保证三件事：**archive 中旧 champion 不丢失、在明确统计假设下限制误升级概率、在明确预算下限制 canary 暴露；**不能保证真实未来分布上的单调改进。**

---

## 2. 一手资料给出的证据与边界

| 来源 | 可迁移机制 | 不能外推为 |
|---|---|---|
| [Darwin Gödel Machine，arXiv:2505.22954，ICLR 2026](https://arxiv.org/abs/2505.22954) | 保留全部有效后代的 archive、完整 lineage、从高分但欠探索的父代继续分支；沙箱、资源限制和人工监督 | 每个后代优于父代；生产性能单调。DGM 只要求后代仍可运行/自修改，评分又来自分阶段、带噪 benchmark 子集；archive 的 best-so-far 不下降主要来自“旧解不删除” |
| [Gödel Agent，arXiv:2410.04444](https://arxiv.org/abs/2410.04444) | 用 validation feedback 递归修改自身逻辑；实验明确出现 temporary dips | 单链更新天然稳定。短期下降正说明必须保留 champion 和独立 release gate |
| [EvoMAC，arXiv:2410.16946](https://arxiv.org/abs/2410.16946) | 用编译/测试产生 objective feedback，并通过 textual backprop 修改 agent prompt 与连接 | 生成的 target proxy 完整正确；反复贴合代理测试不会过拟合；固定轮次必然继续增益 |
| [SEW，arXiv:2505.18646](https://arxiv.org/abs/2505.18646) | validation/test split、生成多个 workflow 变体、检查逻辑有效性和代码可执行性 | “从大量候选选最好”没有 winner’s curse；生成式 mutation 总能产生合法 workflow。论文也报告部分 workflow 逻辑上可读但执行失败 |
| [Socratic-SWE，arXiv:2606.07412](https://arxiv.org/abs/2606.07412) | 独立 held-out validation、执行式任务 gate、regression avoidance、跨轮刷新验证梯度；对照方法在后续轮次出现回退 | 闭环无限增长。论文在固定仓库池上约第 5 轮趋于饱和，并明确属于 closed-world；其表格也直接展示若干 self-evolving baseline 第 2/3 轮回退 |
| [AI Agents That Matter，arXiv:2407.01502](https://arxiv.org/abs/2407.01502) | agent 评测必须同时控制正确率与成本；需要真正 holdout、可复现配置和防 benchmark shortcut | 只看 pass rate 或 leaderboard 就能判断系统真实进步 |
| [SPIBB，ICML 2019](https://proceedings.mlr.press/v97/laroche19a.html)；[Conservative Bandits，ICML 2016](https://proceedings.mlr.press/v48/wu16.html) | 不确定区域回退 baseline；在假设成立时，用高概率约束限制策略相对 baseline 的损失 | 开放世界 agent 部署的无条件安全保证。理论依赖数据覆盖、奖励定义、平稳性或模型假设 |
| [Always Valid Inference](https://arxiv.org/abs/1512.04922) | 对连续监控和数据依赖停止使用 always-valid p-value/CI | 用普通固定样本检验每天偷看结果仍保持原显著性水平 |
| [ADWIN 原始论文](https://www.cs.upc.edu/~gavalda/papers/adwin06.pdf)；[GEM，NeurIPS 2017](https://papers.nips.cc/paper/7225-gradient-episodic-memory-for-continual-learning) | 自适应窗口检测均值变化；用历史任务矩阵测 backward transfer/forgetting | 所有语义漂移都能被单一检测器及时发现 |
| [Google SRE：Canarying Releases](https://sre.google/workbook/canarying-releases/) | 小流量、限时暴露、与 control 对比、自动判定与快速回滚，降低坏版本爆炸半径 | canary 本身证明版本无缺陷 |

**核心反证：**Socratic-SWE 的对照结果显示 R-Zero、SPIRAL、Absolute-Zero、Socratic-Zero 均可在后续轮次回退；Gödel Agent 也承认中间性能下探。因而“自反馈 + 多轮优化”不是单调性的证据。

---

## 3. 稳定性目标：三层而不是一个分数

### 3.1 三层保证

```text
L1 版本安全：旧 champion 永远可寻址、可复现、可回滚。
L2 统计安全：在冻结的评测设计与显著性预算下，限制误 promotion 概率。
L3 运行安全：在 canary 暴露和累计探索预算内，限制坏 challenger 的影响范围。
```

### 3.2 明确不承诺

以下均不能由本系统保证：

- 未见未来任务分布上的单调改进；
- evaluator 不完整、被投机或发生漂移时的真实性能；
- 极低概率安全事故为零；
- 第三方模型/API、工具链、仓库生态改变后的等价性；
- 非独立任务、延迟标签和选择偏差下仍保持名义置信度；
- 不可逆外部副作用的通用 exactly-once。

因此准确表述应是：

> **Champion-gated evolution 在版本、统计和暴露预算三层降低退化风险，并在假设成立时给出概率上界；它不证明闭环在开放世界中单调改进。**

---

## 4. Archive 与 Champion–Challenger

### 4.1 不可变版本记录

```yaml
WorkflowVersion:
  version_id: sha256
  parent_version_ids: []
  graph_ir_digest: sha256
  prompt_model_tool_bundle_digest: sha256
  runtime_policy_digest: sha256
  created_by: mutation | merge | manual | retrieval_edit
  task_strata: []
  edit_manifest: []
  source_trace_ids: []
  evaluation_manifest_id: sha256
  artifact_bundle_ref: cas://...
  status: candidate | shadow | canary | champion | retired | quarantined
  rollback_compatible_with: []
```

`EvaluationManifest` 必须冻结：任务 ID、repo snapshot、测试版本、模型精确版本、工具/依赖、预算、seed、执行顺序、失败日志、原始 task-level paired outcome。只保存汇总均值不够。

### 4.2 Archive 分区

- `champions/`：每个 `task_stratum × risk_tier × budget_tier` 一个当前指针；
- `history/`：最近至少 5 个 champion 及所有曾进入 canary 的版本；
- `pareto_elites/`：质量、成本、时延的非支配版本，供后续进化作为 stepping stone；
- `challengers/`：未完成门控的候选；
- `quarantine/`：安全违规、不可复现、疑似 evaluator hacking 的版本；
- `tombstones/`：只允许回收大体积运行制品，不删除 lineage、摘要和决策证据。

### 4.3 不变量

1. Promotion 只原子更新 champion pointer，不覆盖旧版本。
2. 新版本不能修改 evaluator、release gate、安全策略或自身 promotion 规则。
3. 候选不得读取 blind gate 的隐藏答案、任务级得分或最终测试补丁。
4. 任一执行必须能追溯到完整 bundle；无法复现的结果不进入 gate。
5. 高风险 mandatory verifier/human gate 不得被 mutation 删除或弱化。

---

## 5. Paired Held-out Promotion Gate

### 5.1 数据分层

```text
Search/Dev set       允许进化器读取，用于生成和调参
Release Gate set     冻结、盲化、候选生成后才执行；不得用于训练
Sentinel set         长期固定的旧能力回归集，用于遗忘监控
Canary stream        真实流量中的随机对照样本
Final audit set      仅里程碑/论文使用，不能反复消费
```

Release Gate 建议至少：

- 300 个 paired tasks；
- 20 个以上 repository；
- 每个主要 stratum 至少 30 个任务；
- 样本量最终以 CI 宽度/功效计算为准，达不到即 `INCONCLUSIVE`。

每个 task 上 champion 与 challenger 使用相同 repo snapshot、模型/工具版本、token/time 上限和可比 seed；随机交换执行先后。统计单位是 **task/repository**，不是单次 LLM call 或节点。

### 5.2 指标层级

**硬门，不参与加权抵消：**

- 安全/权限/secret/未授权写入事故；
- 重复或未知外部副作用；
- evaluator、测试或 policy 被篡改；
- graph/type/effect/budget invariant；
- trace/provenance 完整性。

**主要质量指标：**resolved/pass rate、critical regression rate、任务级 verifier 通过率。

**次要效率指标：**成功任务 token/$、wall-clock、p95/p99 latency、工具调用数、fallback rate。

**长期指标：**旧 stratum forgetting、rollback rate、false-promotion rate、archive diversity。

### 5.3 Paired 统计判定

令 task-level 差值：

\[
\Delta_Q = Q_{challenger}-Q_{champion}
\]

\[
\Delta_C = \frac{Cost_{challenger}-Cost_{champion}}{Cost_{champion}}
\]

推荐用 repository-clustered paired bootstrap（至少 10,000 次）生成单侧 95% CI；paired binary pass/fail 可同时报告 exact McNemar。连续监控改用 confidence sequence，不能重复使用固定样本 CI。

### 5.4 MVP Promotion 规则

候选必须全部满足：

```text
A. hard_safety_violations == 0
B. trace/provenance completeness >= 99%
C. LCB95(ΔQ_overall) > -δQ
D. 对每个 protected stratum：LCB95(ΔQ_stratum) > -δS
E. 以下至少一项成立：
   E1. LCB95(ΔQ_overall) > 0；或
   E2. UCB95(ΔCost) < -10%；或
   E3. UCB95(Δp95_latency) < -10%
F. UCB95(critical_regression_delta) <= 0
G. 无单一 repo 贡献超过总收益的 35%
H. blind gate、shadow、canary 三阶段方向一致
```

MVP 非劣 margin：

| 风险档 | `δQ` / `δS` 起始值 |
|---|---:|
| 高风险、外部副作用、安全相关 | 0–0.5 个百分点；默认人工审批 |
| 标准 coding workflow | 1 个百分点 |
| 只读、低风险、明显成本优化 | 2 个百分点 |

这些 margin 是产品可接受损失，不是由论文推出的常数。若想以质量换成本，必须在进入实验前书面冻结 trade-off，不能看到结果后再改 margin。

### 5.5 多重比较与 winner’s curse

- 同一轮生成大量 challenger 时，先用 dev 排序，**最多 1–2 个**进入 blind gate；
- promotion 假设按固定顺序检验：安全 → 总体质量非劣 → 分层非劣 → 效率/优越性；
- 同一个 release gate 被消费多次后必须轮换或补充新任务；
- 不允许从 100 个候选中挑 blind gate 分数最高者后仍用普通 0.05 阈值声称显著。

---

## 6. Offline → Shadow → Canary → Promote → Rollback

### Stage 0：Candidate Admission

- IR type/effect/cycle/budget/permission 静态检查；
- sandbox 编译、最小 smoke test、determinism/replay 检查；
- 生成 immutable bundle 与 rollback plan；
- 失败直接 `QUARANTINED`。

### Stage 1：Offline Search

- 只使用 dev/search data；
- 与当前 champion 做等预算 paired evaluation；
- 可淘汰明显劣势候选，但不能 promotion；
- 通过后执行 blind Release Gate。

### Stage 2：Shadow

- challenger 接收真实任务镜像，但输出不影响用户、仓库或外部系统；
- 比较路由覆盖、工具兼容、成本、时延、行为漂移和 verifier 结果；
- 推荐至少 100 个任务或 7 天，取先满足者；高风险任务延长。

### Stage 3：Canary

建议阶梯：

```text
1% → 5% → 10% → 25% → 50% → 100%
```

每级必须同时满足：最小样本、最小驻留时间、confidence-sequence 门槛和无 kill event。流量按 task stratum 分层随机；不得只把简单任务给 challenger。

### Stage 4：Promote

- 原子切换 champion pointer；
- 旧 champion 保持 warm standby；
- 新 champion 进入 7 天或至少 500 个任务的强化监控期；
- 强化期内禁止同时 promotion 第二个改变相同关键路径的版本。

### Stage 5：Rollback

触发后：

1. 停止新任务路由给 challenger；
2. 原子恢复上一 champion bundle；
3. 取消无副作用运行；对已有副作用执行 reconciliation/compensation；
4. 隔离 challenger 缓存、证书和派生产物；
5. 保留完整证据并标记失败 signature；
6. 禁止同一 digest 自动重试上线。

**Rollback SLO 起始值：**纯 workflow/prompt/model pointer 5 分钟内；涉及 runtime/schema/cache migration 的版本 30 分钟内。无法达到者不得进入 canary。

---

## 7. Drift 与灾难性遗忘监控

### 7.1 四类 drift

| 类型 | 监控信号 | 动作 |
|---|---|---|
| 输入/任务漂移 | TaskCard embedding、语言/框架、repo 大小、task family、风险档位；MMD/分类器 AUC | Yellow：减少探索并触发重跑 gate；Red：冻结 promotion |
| 结果漂移 | pass、critical regression、成本、p95/p99、fallback；按 stratum 用 ADWIN/CS | 超 margin 回滚 |
| 行为漂移 | 节点数、循环轮次、工具分布、写集、网络目标、cache hit、广播量 | 未解释的结构突变进入 quarantine |
| 依赖漂移 | 模型 revision、toolchain、provider policy、evaluator/test、repo 生态 | 旧证书失效；重新 shadow/canary |

建议告警：

```text
YELLOW:
  两个连续窗口质量下降 > 1pp，或成本/时延上升 > 10%
  → exploration_budget × 0.5，重跑 sentinel + gate 子集

RED:
  CS 上界确认质量下降超过 δQ；
  任一 severe safety event；
  p99 时延/成本连续两个窗口 > champion 1.25×
  → 立即停止 challenger、回滚、冻结同 lineage
```

### 7.2 遗忘矩阵

对每个版本 `v` 和历史 stratum `s` 记录：

\[
R_{v,s}=\text{paired held-out score of version }v\text{ on stratum }s
\]

\[
F_{v,s}=\max_{u\le v}R_{u,s}-R_{v,s}
\]

并报告 backward transfer：新版本是否改善旧任务，而不只看当前轮任务。

MVP 保护规则：

- sentinel 中至少 30% 来自旧版本曾经擅长的 strata；
- `F_overall > 1pp` 或任一 protected stratum `F_s > 3pp`：禁止 promotion；
- 发生遗忘时优先保留 per-stratum champion 或路由门控，不强迫一个 workflow 覆盖全部任务；
- archive 版本不得因新候选出现而物理删除；模型微调时必须 replay 历史 anchor tasks。

---

## 8. 探索预算

借鉴 conservative bandit/SPIBB，只在证据充分处偏离 baseline；否则路由 champion。

### 8.1 预算账本

```yaml
ExplorationBudget:
  max_canary_task_share: 0.05
  max_weekly_extra_tokens: 0.10 * baseline_tokens
  max_weekly_extra_cost: 0.10 * baseline_cost
  max_cumulative_quality_debt: 2.0 task_equivalents
  max_severe_incidents: 0
  reserved_rollback_budget: 0.20 * total_budget
```

`quality_debt` 按 paired 结果累计；使用保守下界估计。预算耗尽即只运行 champion，不允许“为了收集更多证据”继续暴露。

### 8.2 风险分配

| 场景 | 自动探索上限 |
|---|---|
| 离线 sandbox | 受总 compute budget 限制，可广泛探索 |
| Shadow | 可镜像较高比例，但不得产生真实副作用 |
| 只读/低风险 canary | 初始 1–5% |
| 普通代码写入 | 初始 1%，隔离 worktree，最终提交仍需 verifier |
| 安全、支付、部署、凭证、不可逆外部操作 | 0%；仅离线/人工批准 |

当漂移、429、预算超支或 verifier 覆盖下降时，探索比例自动降为 0。

---

## 9. Kill Criteria

### 9.1 单个 Challenger 立即终止

任一项触发：

- 任一高严重度安全、权限、secret 或 evaluator tampering 事件；
- 非幂等外部副作用出现重复或状态未知；
- provenance/trace 缺失率 > 1%；
- CS/paired gate 确认质量低于非劣 margin；
- canary p99 latency 或单位成功成本 > champion 1.25×，持续两个窗口；
- 循环、retry、消息放大超硬预算；
- rollback 演练失败或超过 SLO；
- 相同失败 signature 连续 3 次且无新证据；
- 任何 protected stratum critical regression 未解决。

### 9.2 暂停整个自动进化闭环

- 最近 20 个 challenger 中，blind gate 通过率 < 5%，且搜索成本超过预计 90 天节省；
- 连续 3 个 evolution cycle 在 held-out 上无正效用，或 dev 提升但 held-out 非劣失败率 > 70%；
- 两次误 promotion 导致 production rollback；
- evaluator 发现泄漏、reward hacking 或与人工审计显著不一致；
- release gate 被过度消费且无法补充新 holdout；
- drift 检测长期 Red，说明 task distribution 已超出当前模板库覆盖；
- 回滚、archive 或审计链不再可靠。

触发后退回 `offline-only`，先修复 evaluator、数据、IR 或监控，不继续堆搜索算法。

---

## 10. 评测协议

### 10.1 必须比较

1. 固定 tree baseline；
2. 当前 champion；
3. challenger；
4. 无 archive 的“只保留最新版本”；
5. 无 paired gate；
6. 无 drift/forgetting monitor；
7. 固定 epsilon 探索 vs conservative budget；
8. 全局 champion vs per-stratum champions。

### 10.2 纵向报告

至少运行 5 个 evolution rounds，同时报告：

- `current-version performance`：本轮实际版本；
- `archive best-so-far`：历史最优；
- `production champion performance`：真正上线版本；
- 每轮候选数、gate 通过率、promotion/rollback 次数；
- pass/resolved、critical regression、token/$、p50/p95/p99 latency；
- false-promotion rate、time-to-detect、time-to-rollback；
- forgetting matrix 与最差 stratum；
- cumulative exploration debt；
- archive diversity/Pareto frontier。

只画 best-so-far 曲线会把退化隐藏掉，禁止作为唯一“持续改进”证据。

### 10.3 故障注入

- 模型/API 版本切换；
- 测试/evaluator 漂移；
- task mix 突然变化；
- hidden test leakage；
- correlated repo cluster；
- delayed outcome；
- canary routing bias；
- cache/schema 不兼容；
- rollback 期间仍有运行中副作用；
- winner’s curse：从 100 个候选中挑最高分者。

### 10.4 MVP 验收门槛

- 100% 版本可复现、可定位 parent、可回滚；
- 0 个高严重度安全违规被 promotion；
- 所有 promotion 均有 frozen paired manifest；
- 注入的坏版本 100% 在 canary 上限内终止；
- rollback 成功率 100%，满足 SLO；
- held-out 质量满足非劣，且 token 或 p95 latency 至少下降 10%，或质量 CI 明确优于 champion；
- 任一 protected stratum 无超过门槛的遗忘；
- 报告当前版本曲线，而非仅 best-so-far。

---

## 11. 核心控制伪代码

```python
def evolve_and_release(challenger, champion, policy):
    bundle = freeze_bundle(challenger)

    if not static_validate(bundle, policy):
        return quarantine("static-or-policy-failure")

    offline = paired_eval(bundle, champion, policy.dev_set)
    if clearly_dominated(offline):
        return archive_rejected(offline)

    gate = paired_eval_blind(bundle, champion, policy.release_gate)
    decision = promotion_gate(gate, policy)
    if decision != "PASS":
        return archive_inconclusive_or_rejected(gate)

    shadow = run_shadow(bundle, champion, policy.shadow_budget)
    if drift_or_kill(shadow, policy):
        return quarantine_with_report(shadow)

    rollback_token = rehearse_rollback(bundle, champion)
    if not rollback_token.success:
        return quarantine("rollback-not-ready")

    for share in [0.01, 0.05, 0.10, 0.25, 0.50]:
        canary = run_stratified_canary(
            challenger=bundle,
            control=champion,
            traffic_share=share,
            confidence_sequence=True,
            exploration_budget=policy.exploration_budget,
        )

        if canary.kill_event or canary.budget_exhausted:
            rollback(champion, rollback_token)
            return quarantine_with_report(canary)

        if not canary.has_enough_evidence:
            return keep_at_current_stage(canary)

    old = atomic_promote(bundle)
    keep_warm(old)
    start_enhanced_monitoring(bundle)
    return "PROMOTED"
```

---

## 12. 推荐 MVP 实施顺序

1. **P0：**不可变 WorkflowVersion、EvaluationManifest、per-stratum champion pointer；
2. **P0：**blind paired gate + repository-clustered CI + `INCONCLUSIVE` 状态；
3. **P0：**一键 rollback、cache/schema 隔离、kill switch；
4. **P1：**shadow/canary 分层路由和 anytime-valid monitor；
5. **P1：**sentinel forgetting matrix、drift detector；
6. **P1：**exploration budget ledger；
7. **P2：**再接 DGM 式 archive parent selection、SEW/EvoMAC 式 mutation、Socratic-SWE 式自适应课程。

**最终定案：**

> 自进化器可以激进地产生候选，但发布器必须保守。DGM 式 archive 负责保留 stepping stones，paired held-out gate 负责防止 benchmark 内退化，shadow/canary 负责降低现实暴露，drift/forgetting monitor 负责发现环境变化，rollback 负责恢复。该闭环能实现的是“可审计、可回退、统计上受控的改进尝试”，而不是“每一轮、每个任务、每个未来环境都单调变好”。
