# @wea/runner

WEA 的 L1（采集）+ L2（执行）层：在 pi SDK 上进程内驱动多节点 workflow 图，
产出两种 trace 面。Phase 1 MVP，对应 `PI_INTEGRATION_PLAN.md` §5。

## 运行

```bash
# 需 Node >= 20（pi-tui 用 v regex flag；本机装了 ~/.local/opt/node-v22.17.0-linux-x64）
cd runner && npm install

export WEA_BASE_URL=... WEA_API_KEY=... WEA_MODEL=...   # Anthropic messages 格式端点

npx tsx src/run.ts \
  --task "node test.js fails: ... fix it" \
  --template t2-bugfix \
  --repo /path/to/target-repo \
  --out runs
```

产出三个文件（`runs/<template>-<runid>.*`）：

| 文件 | 契约 | 消费者 |
|---|---|---|
| `*.trace.json` | `wea.trace/v1` | `python3 tools/validate_ir.py <file>`（强制闸门） |
| `*.pvf.json` | `wea.pvf.trace/v1` | `python3 prototypes/attribution.py <file> --pretty`（PVF 归因） |
| `*.manifest.json` | 内部 RunManifest | `npx tsx src/rebuild.ts <file>` 可离线重建上面两个 |

## 结构

```
src/
  types.ts         图/预算/记录的共享类型
  graph.ts         调度器：ALL_SUCCESS/ANY_SUCCESS + SEAL + 依赖失败传播
                   + 有界 FEEDBACK 循环（运行时展开，attempt_no 递增）
                   + 节点级有界重试（retryNode）
  budget.ts        运行级硬预算（token/$/墙钟），超支 → session.abort()
  recorder-ext.ts  pi InlineExtension：tool_call/tool_result/usage 采集，
                   路径规范化（D23）、敏感路径 redaction（SEC-001）、
                   content digest 自算（D22，pi 不提供 digest）
  node-session.ts  节点 ↔ AgentSession（D19 prompt 通道；D21 JSON 契约解析，
                   容忍散文包裹的平衡花括号提取）
  library.ts       library/templates/*.json + library/agents/*.md 装载
  trace-export.ts  RunManifest → 双 trace 面（合规 + PVF 投影）
  run.ts           CLI 事件循环（并行 spawn、重试、状态判定含 verdict）
  rebuild.ts       从 manifest 离线重建 trace（迭代 exporter 不烧钱）
  smoke-export.ts  无网络冒烟：合成 manifest → 两面 trace
```

模板：`library/templates/`（t0-direct / t1-safe-generic / t2-bugfix / t3-complex），
角色卡：`library/agents/`（inspector / implementer / verifier / explorer / aggregator），
格式沿用 pi subagent 示例（frontmatter + system prompt），全部强制 JSON 输出契约。

## 已实测（2026-07-14）

- T2 真实修 bug（fizzbuzz 15 缺角）：3 节点全绿，bug 实修，trace VALID，
  PVF credit：regression 1.0 / patch 0.5 / localize 0.24，零死节点。
- T3 真实加功能（slugify）：2 explorer 并行 → aggregate → implement → verify，
  tests 过，trace VALID，PVF 双覆盖率 1.0。
- 合成冒烟（含 fix-loop 二轮）：验证 loop 展开的 trace/PVF 形态。

## Phase 1 已知边界

- 无 worktree 写隔离（D11 留待多写者模板前实现；当前模板单写者）。
- 无 per-node 预算执行（类型有，执行只在 run 级 ledger）。
- 高并发 + provider 限流反压未测（SCHED-002）。
- 真实 run 中 fix-loop 未触发过（verifier 首轮即 pass）；loop 机制由合成冒烟覆盖。
