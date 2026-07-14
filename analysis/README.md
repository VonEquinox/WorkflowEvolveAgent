# analysis/ — L4 复盘进化层（Phase 2）

把一次 run 的 trace 变成"下一版更好的模板"。这是用户愿景里"AI 总结经验、学会怎么分配/怎么写 prompt"的第一次兑现——**提案权在 AI，安全兜底在确定性代码，改进靠配对 A/B 证明**。

## 闭环

```
run (runner) ──> *.trace.json + *.pvf.json
                      │
                      ▼
  ① postmortem.py     PVF 归因 + 成本 → 浪费报告（wea.postmortem/v1）
                      │   findings: redundancy / low_efficiency / dead / critical_path_waste
                      │   安全护栏：verifier/aggregator/终端节点标 protected，永不进删减候选
                      ▼
  ② meta-improve.ts   meta-improver pi session 读报告+模板 → 改进提案（wea.proposal/v1）
                      │   只提两类可机械应用的编辑：remove_node / edit_prompt
                      ▼
  ③ template-edit.ts  结构可执行性检查 gateProposal()——**不是安全审查**：
                      │   只验"这个重设计能不能跑"：边指向真实端点、@input→@output
                      │   可达、无非法环、无孤儿。删 verifier、塌缩全图、换模型都放行；
                      │   只有"跑不起来"（语法/结构错）才拦。
                      │   通过 → applyProposal() 写 challenger 版本 <id>@<ver>.json（旧版不动）
                      ▼
  ④ ab_compare.py     champion gate：同任务配对重跑 N 次，中位数比较 token/cost/pass
                      │   challenger 只有**赢下配对评测**才取代 champion；输了回滚，旧版永存
                      ▼
                   权力来自赢得测量，不来自被许可（D28）
```

**信任 AI（D28）**：meta-agent 可任意重设计模板——删 verifier、加节点、重构全图、换模型，没有"禁止清单"。安全不在提案端（那假设 AI 会犯蠢、且与 champion-gate 主张矛盾），而在结果端：任何新版本都是 challenger，靠赢下 A/B 才晋级。gate 只保证"能跑"（信任 AI 思想是好的、只查语法）。唯一保留的物理护栏：试跑不可造成不可逆外部副作用（靠沙箱/worktree，非限制 AI 判断）。

## 用法

```bash
# ① 复盘一次 run
python3 analysis/postmortem.py runner/runs/<run>.pvf.json \
    --trace runner/runs/<run>.trace.json --template t3-complex \
    --json runner/runs/<run>.postmortem.json

# ② + ③ meta-agent 出提案，过门禁，写新版本（需 WEA_* 环境变量）
cd runner && npx tsx src/meta-improve.ts \
    --report runs/<run>.postmortem.json --template t3-complex --apply

# ④ 配对 A/B 量化改进
python3 analysis/ab_compare.py --a t3-complex --b "t3-complex@1.0.1" \
    --repo /tmp/sandbox --test "node test.js" --task "..." --n 3 \
    --json runner/runs/ab/ab_result.json
```

## 安全设计（为什么这套不会"进化出灾难"，而又信任 AI）

- **信任提案、裁决结果**：meta-agent 想改什么改什么，gate 不审查意图，只查"能不能跑"（8 条单测：删 verify+重接线/塌缩单节点/换模型/加 verifier 全放行，仅悬空边/孤儿/断路拦）。灾难不靠"禁止 AI 想它"来防，靠"没赢下测量就不能当默认"来防。
- **单 trace 是弱证据**：改进不靠一次跑，靠 `ab_compare.py` 的配对中位数（v0.2 §11.3）。challenger 非劣化 + 至少一项成本改善才晋级。
- **旧版永不篡改**：challenger 写成 `<id>@<ver>.json`，原 `<id>.json` 不动——对齐"immutable archive"；输了就回滚到它。
- **唯一物理护栏**：试跑不可有不可逆外部副作用（沙箱/worktree 隔离）——这是环境属性，不是对 AI 判断力的限制。

## 已实测（2026-07-14）

在真实 t3-complex 的 slugify run 上：postmortem 抓到"两个并行 explorer credit 相等、过度并行"→ meta-improver 自主提"删 explore_b"（理由精确、预测省 ~15% token）→ gate PASS → 写出 `t3-complex@1.0.1.json`（4 节点，fix loop 完整）→ A/B 配对量化。这是**闭环第一次在真实数据上自主跑通**。
