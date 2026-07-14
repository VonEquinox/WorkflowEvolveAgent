# 总架构红队：10 条最关键 P0/P1 修正

> 核验范围：`SELF_EVOLVING_AGENT_RESEARCH_PLAN_v0.2.md`、`research/reports/00–06`、`research/OPEN_ISSUES.yaml`  
> 核验日期：2026-07-13

| # | 级别 | 最关键问题 | 一句修正建议 |
|---:|:---:|---|---|
| 1 | **P0** | **权威 IR 仍然分裂。** `02` 的 `GraphIR/graph_revision_id` 与 `05` 的 `WorkflowTemplate/WorkflowInstance/spec_digest` 是两套身份、版本和节点模型，无法保证 Trace、Cache、蒸馏和回滚引用的是同一对象。 | 只保留一个 canonical `WorkflowTemplateRelease` 和一个绑定后的 `WorkflowInstance`，把 `GraphIR` 明确定义为其编译视图，并统一使用 `template_release_digest + instance_digest` 外键。 |
| 2 | **P0** | **effect 术语互相冲突。** `OPEN_ISSUES`、`02`、`03`、`05` 分别使用四套 `PURE/READ_ONLY/IDEMPOTENT/COMPENSATABLE/WRITE` 枚举，导致 cache、retry、speculation、merge 与权限规则无法共用。 | 废弃单枚举，改为正交字段 `reads/writes/external_effect/replayability/idempotency/compensation/authority`，所有 WS 只引用这一份版本化 Effect Schema。 |
| 3 | **P0** | **“不可变 WorkflowInstance”无法表示 online DAG。** `03` 允许运行时 `ADD_NODE/ADD_EDGE`、replan epoch 和封口，而 `02/05` 的实例与 Trace 只记录静态 logical node，动态扩展后节点身份、缓存键和归因都会碰撞。 | 增加不可变 `GraphDeltaEvent` 日志，并用 `(instance_digest, epoch, logical_node_id, expansion_index)` 作为运行时节点身份；sealed epoch 只能由新 epoch 取代。 |
| 4 | **P0** | **Trace→PVF/GCC 接口不闭合。** `01` 需要 atom/hunk/claim 级 `use/derive/validate/overwrite/retained` 关系，但 `02` 只有 attempt 级 input/output 和逻辑边，无法实现所声明的 credit estimator。 | 在 Trace IR 中正式加入 `ArtifactAtom`、`ArtifactUseEvent`、`DerivationEvent` 和 final-retention/verifier anchor；做不到时必须把归因主张降为 artifact/node 级弱代理。 |
| 5 | **P0** | **“dependency-sound EXACT”依赖不可实现的完整性假设。** shell/compiler/LSP/network/negative query 的 read-set 完整性没有可验证定义，且 `model_revision` 可为空、LLM 非确定性未进入可执行判据，却要求 false exact reuse 为 0。 | 定义可审计的 capture profile；MVP 仅对 hermetic、确定性、完整依赖可强制捕获的 operator 开 EXACT，其余统一称 `verified result reuse` 或直接 MISS。 |
| 6 | **P0** | **核心契约对象尚不存在。** `TaskContract/AcceptanceContract/ArtifactRecord/PatchEnvelope` 在缓存、聚合、merge、verifier、promotion 中被反复调用，却没有共同 schema、满足关系、证据强度和版本兼容规则。 | 先发布共享的 Contract/Artifact/Patch/Verification JSON Schema 与 conformance tests；在其落地前禁用 semantic direct hit、自动 code merge 和自动 champion promotion。 |
| 7 | **P0** | **数据污染可以进入控制面。** issue/repo/web 文本被标记 taint，但 `06` 的 slot resolver/editor 和 `05` 的 `test_command: string` 仍可直接决定命令、工具、路径与网络目标，存在 prompt/command injection。 | 命令改为类型化 `CommandSpec(argv, cwd, env, capability)`，所有 tainted 值经过 policy engine 与 allowlist 校验，禁止其直接控制 tool、shell、权限、网络或写入范围。 |
| 8 | **P0** | **merge、result ledger、CAS 与 cache publish 没有统一原子提交。** 隔离 worktree、三方 merge、最终测试、`commit_once`、目标 ref CAS 和证书发布分散在 `02/03/04`，可能把旧 attempt 或旧 snapshot 的结果发布为有效缓存/最终 patch。 | 定义单一 `PromotionTransaction`：锁定 base snapshot 和 attempt generation，生成 candidate tree，完成验证，CAS 更新目标 ref，最后原子发布 Artifact/Certificate/Cache；任一步失败全部作废。 |
| 9 | **P1** | **全链路评测仍会泄漏且门槛不可证。** PVF anchors、motif mining、retriever/editor、champion gate 可能复用同一任务/测试证据；同时用 50–200 traces 和约 96 LOO pairs 声称多个“0 错误/100%”门槛没有统计意义。 | 在任何挖掘前冻结 repo+时间分组的 discovery/calibration/promotion/final-test 四级数据注册表，并把绝对零改为预注册样本量下的风险上置信界和 sequential canary。 |
| 10 | **P1** | **剩余 novelty 仍可能被近邻工作击穿。** `Agents that Matter`（arXiv:2605.27621）逼近 removal attribution，Agentix（NSDI 2026）覆盖动态 program-aware scheduling，FlowReasoner/MaAS 覆盖 query-conditioned workflow，AgRefactor（2606.30949）与 SEMAG（2603.15707）继续推进 self-evolving coding workflow。 | 不再主张任一组件首创，只主张并消融验证“repo/effect-aware contracts + dependency-gated reuse + calibrated attribution + typed constrained evolution”的统一闭环及其公开 benchmark。 |

