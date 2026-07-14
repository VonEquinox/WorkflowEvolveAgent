# Phase 0 Spike — FINDINGS

> 日期：2026-07-14
> 宿主：`@earendil-works/pi-coding-agent@0.80.6`（npm，未 fork）
> 端点：Anthropic messages 格式自定义代理（`WEA_BASE_URL/WEA_API_KEY/WEA_MODEL`）
> 脚本：`spikes/phase0/spike.mjs`（1 planner + 2 并行 worker）、`connectivity-test.mjs`
> 对应文档：`PI_INTEGRATION_PLAN.md` §8 的 5 个未知点（U1–U5）

---

## 0. 一句话结论

**§8 的 5 个未知点全部实测通过，pi SDK 作为 WEA runner 宿主的关键机制成立，Phase 0 kill criteria 未触发，可进入 Phase 1。** 三个采集/编排要件——per-node system prompt 隔离、并行会话隔离、per-node token/cost 采集——在真实端点上均验证为真。两个此前只有静态源码把握的点（`appendEntry` 真实签名、`tool_result` 是否带 digest）已由 live run 证实。另额外发现两个影响 runner 设计的事实（路径规范化、敏感文件读取），记入 §3。

运行环境注意：pi 依赖 `pi-tui` 使用了 `v` regex flag，**要求 Node ≥ 20**（本机默认 Node 18 会 `SyntaxError`）。实测用 Node 22.17.0 通过。此约束需写入 runner 的 `engines` 字段。

---

## 1. 实测数据（single run，3 节点）

| 节点 | llm_calls | tokens | cost | latency | tool_calls | read-set 候选 |
|---|---|---|---|---|---|---|
| planner（只读白名单）| 3 | 11982 | $0.035432 | 28450ms | 5 `[ls,read×4]` | `.` `package.json` `connectivity-test.mjs` `spike.mjs` `.env` |
| worker-A（`[read,ls]`）| 2 | 2088 | $0.005586 | 6215ms | 1 `[read]` | `/home/.../phase0/package.json` |
| worker-B（`[ls,find]`）| 3 | 2960 | $0.007238 | 27053ms | 2 `[find,ls]` | `*.mjs` `.` |

- 两 worker 并行 wall-clock = **27055ms ≈ max(6215, 27053)**，而非 33268ms（=串行和）。→ **真并行**（U3 硬证据）。
- 每节点 token/cost 来自 `message_end` 事件的 `message.usage`（原生字段 `{input, output, totalTokens, cost{total}}`）累加，无需自算。→ **L1 采集层的成本记账可行**。

---

## 2. U1–U5 逐条结论

### U1 — per-node 自定义 system prompt 通道 ✅ 固化：`DefaultResourceLoader#systemPromptOverride`

- **问题**：SDK 场景下按节点注入不同 system prompt 的正式通道（`before_agent_start` vs `resourceLoader` vs 直接字段），选定其一。
- **实测**：每节点用独立 `DefaultResourceLoader({ systemPromptOverride: () => nodePrompt })`。worker-A（“只答 JS/package.json 问题”）回 `"The package.json declares the package name as @wea/spike-phase0"`；worker-B（“只汇总文件计数”）回 `"2"`。两者严格停在各自角色内，互不串味。
- **源码依据**：`resource-loader.ts:478` `this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(base) : base`；signature `systemPromptOverride?: (base: string | undefined) => string | undefined`（`resource-loader.ts:155`）。
- **结论 / Phase 1 落点**：
  - `node-session.ts` 用「一个节点 = 一个 `DefaultResourceLoader`（`systemPromptOverride` 注入角色卡正文）+ 一个 `createAgentSession`」的形态。
  - 备用通道 `before_agent_start` 返回 `{ systemPrompt }`（`types.ts:1080`）可**按 turn** 覆盖，适合动态改写；但节点级静态角色用 loader override 更简单、开销更低，**定为主通道**。
  - 每节点独立 loader → `reload()` 有磁盘发现开销；Phase 1 需评估是否缓存/复用 loader 骨架（见 §3.3）。

### U2 — inMemory session 下 `appendEntry` 行为 ✅ 但 recorder 必须自带落盘

- **问题**：`SessionManager.inMemory()` 下 `pi.appendEntry()` 是否可用；recorder 能否依赖 session 文件持久化。
- **纠错**：旧 spike 写成 `await ctx?.appendEntry?.({type:"custom",...})` —— **三处错**：(a) `appendEntry` 在 `pi`（ExtensionAPI）对象上，**不在 `ctx`**；(b) 真实签名是**同步** `appendEntry(customType: string, data?: T): void`（`types.ts:1281`），非 async、非传 entry 对象；(c) 可选链 `?.` 在方法不存在时静默返回 `undefined` **不抛错**，导致旧脚本 `appendEntryOk=true` 是**假阳性**。已改用真实 API 并**读回验证**。
- **实测**：`pi.appendEntry("wea-recorder", {marker, label})` 后，从 `sessionManager.getEntries()` 读回：
  ```json
  {"type":"custom","customType":"wea-recorder","data":{"marker":"recorder-marker","label":"planner"},
   "id":"f9e28827","parentId":"b3ca0db6","timestamp":"2026-07-14T00:38:16.331Z"}
  ```
  三节点均 `called=true persisted=true`。→ inMemory 下 append **确实进入内存条目树**（`byId` + `fileEntries`），带 `id/parentId/timestamp`，可即时读回。
- **源码依据**：action 连线 `agent-session.ts:2324` `appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data)`；`session-manager.ts:1051 appendCustomEntry` → `_appendEntry` → `_persist`；`_persist` 开头 `if (!this.persist || !this.sessionFile) return`（`session-manager.ts:946`）。
- **结论 / Phase 1 落点**：
  - inMemory 下 append 进内存**但不落磁盘**（`persist=false` 时 `_persist` 直接 return）；进程退出即丢。
  - **recorder 的 trace 事件不能依赖 session 文件**，必须自带落盘（`recorder-ext.ts` 累积到内存 sink → 节点结束由 runner 写 `trace/*.jsonl`）。这与 D9「runner 记图结构 + recorder 记节点内部」一致，且现在有实测支撑：`appendEntry` 只用于**会话内**标记（如给下游 turn 看的 marker），**不作为 trace 持久化通道**。
  - `parentId` 链存在 → 若日后要用 session 树本身做 trace 派生视图，字段齐备；但 MVP 不依赖它。

### U3 — 并行会话共享 `AuthStorage`/`ModelRegistry` ✅

- **问题**：多个 `AgentSession` 并行、共享同一 auth/registry 的线程安全与 rate-limit 行为。
- **实测**：单个 `AuthStorage` + 单个 `ModelRegistry.inMemory(auth)`，被 planner 与两 worker 共用。两 worker `Promise.all` 并行：3 个 distinct session id、各自 read-set/usage 独立、无串扰；wall-clock 证明真并行（§1）。端点未见 rate-limit 报错（并发度=2）。
- **源码依据**：`sdk.ts:167 createAgentSession` 接受注入的 `authStorage/modelRegistry`；每 session 独立 `Agent` 实例与 `streamFn` 闭包（`sdk.ts:294`）。
- **结论 / Phase 1 落点**：
  - runner 用**进程内单例** auth/registry，节点级只建 session，对齐 D7（SDK 进程内编排）。
  - 本次仅验证并发度 2、同一 provider。Phase 1 `budget.ts` 落地时需补**并发上限 + provider rate-limit 反压**（对齐 SCHED-002）——当前 spike **未覆盖高并发/限流边界**，标为 Phase 1 待测。

### U4 — 节点结构化 JSON 输出 ✅ prompt 契约即可，无需子进程

- **问题**：SDK 内实现节点 JSON 输出契约的最佳方式（subagent 示例用子进程 `--mode json`）。
- **实测**：planner system prompt 要求「只输出 `{summary, files_seen, subtasks}` JSON，无散文无 fence」。最终 assistant 文本经 `tryParseJson`（剥 ```` ```json ```` fence 后 `JSON.parse`）→ `parseable=true`，`keys=[summary, files_seen, subtasks]`。
- **结论 / Phase 1 落点**：
  - **不需要** subagent 示例的子进程 `--mode json`；进程内「强 prompt 契约 + 最终 assistant 文本解析」即可满足 D14。
  - 这是**软约束**：`node-session.ts` 必须实现「解析失败 → 节点失败 → 有界重试」（D14 已写），并把「JSON 解析成功率」作为 Phase 1 采集指标。
  - fence 剥离 + `JSON.parse` 的 helper 直接进 `node-session.ts` 的结果提取。

### U5 — tool 事件是否够 read-set（path + digest？）✅ 路径免费，**digest 需 runner 自算**

- **问题**：read 工具的 tool 事件是否附带内容 digest，决定 read-set 记 `path` 还是 `path+hash`（影响 Phase 4 缓存键）。
- **实测**：
  - **U5a `tool_call.input`**：`ls` → `{"path":"."}`；read/find 分别带 `path`/`pattern`。→ **读取路径/模式免费拿到**。
  - **U5b `tool_result`**：sample read → `isError=false contentTextChars=258 details=null`，`contentHead` 为文件前 80 字符原文。→ **`details` 为 `null`，无任何 content hash/digest 字段**；结果只有 `content[]`（文本/图像）。
- **源码依据**：`ReadToolDetails` 仅 `{ truncation? }`（`tools/read.ts:28`）；`Grep/Find/Ls/BashToolDetails` 同样只含 `truncation`/limit 标志，无 digest（`tools/*.ts`）。`ToolResultEventBase` = `{toolCallId, input, content, isError}`（`types.ts:900`）。
- **结论 / Phase 1 & 4 落点**：
  - read-set 的**路径维度**从 `tool_call` 事件免费获得（read/grep/find/ls 强类型 input）。
  - **内容 digest 维度 pi 不提供**：Phase 4 缓存键若需 `path+hash`，**hash 必须 runner 自算**——两条路径：(a) 对 `tool_result.content` 文本直接 hash（拿到的是「模型实际看到的字节」，最贴合复用语义）；(b) 节点结束时按 read-set 路径重读文件算 hash（更接近 repo snapshot，但有 TOCTOU 与 bash 副作用风险）。**建议默认 (a)**，与 D10「bash volatile 不复用」一致。
  - `bash` 的 `tool_result` 同样无结构化 read-set（仅 stdout 文本）→ 印证 D10，bash 记录但不入缓存键。

---

## 3. 计划外发现（影响 runner 设计，需记入决策）

### 3.1 read-set 路径不规范化：相对 / 绝对 / glob 混用

同一 run 内出现 `package.json`（相对 cwd）、`/home/.../phase0/package.json`（绝对）、`*.mjs`（glob pattern）三种形态。
→ **runner 必须自建路径规范化层**：统一 resolve 到 repo-relative 规范路径后再入 read-set / 缓存键；glob/pattern 类（find/grep）与具体文件读取（read）**分别建模**（pattern 是「负依赖/存在性依赖」，不是精确 read）。这与 v0.2 §4.3「负依赖（absence/glob/search/directory membership）」的要求正好对上，Phase 1 read-set 模型需预留这一区分。

### 3.2 工具白名单 ≠ 路径隔离：planner 在只读白名单下读到了 `.env`

planner 白名单 `[ls,read,grep,find]` 全是只读工具，但它仍 `read` 了 `.env`（含 API key）。
→ **工具白名单只约束「能用哪些工具」，不约束「能读哪些路径」**。敏感文件隔离必须靠**另一层**：worktree 只暴露副本 + 路径 allowlist/denylist（对齐 D11 写隔离、SEC-001 secrets 不入 trace）。Phase 1 recorder 落 trace 时**必须对 read-set 内容与路径做 redaction**（`.env`/`*.key`/`.git/credentials` 等），否则 secret 会进 trace 正文，直接违反 SEC-001。**升级为 Phase 1 必做项**，不是远期。

### 3.3 每节点独立 `DefaultResourceLoader.reload()` 有磁盘发现开销

每节点新建 loader 并 `reload()`（发现 prompt 文件、扩展、themes、agents 文件）。节点数一多，reload 的 IO 累加。
→ Phase 1 评估：loader 骨架是否可在节点间复用（只换 `systemPromptOverride` 与 recorder sink），或提供「轻量 loader」路径跳过无关发现。非阻塞，记为优化项。

### 3.4 延迟基线偏高（代理端点）

connectivity PONG 15.2s；planner 单节点 28.5s。此代理端点 latency 明显高于直连。
→ 不影响正确性结论，但 Phase 1 的 `budget.ts` **时间预算**与端到端跑通耗时需按此基线预估；wall-clock 类指标在此端点上噪声大，成本/token 指标更可信。

---

## 4. 对 §8 清单的回填摘要

| # | 未知点 | 结论 | 固化选择 |
|---|---|---|---|
| U1 | per-node system prompt 通道 | ✅ | `DefaultResourceLoader#systemPromptOverride` 为主；`before_agent_start` 返回 `systemPrompt` 为按-turn 动态备用 |
| U2 | inMemory 下 appendEntry | ✅ 可用但不落盘 | recorder 自带落盘；`appendEntry` 仅作会话内 marker，非 trace 持久化通道 |
| U3 | 并行共享 auth/registry | ✅（并发 2 验证）| 进程内单例 auth/registry；高并发+限流反压留 Phase 1（SCHED-002）|
| U4 | 结构化 JSON 输出 | ✅ | prompt 契约 + 最终 assistant 文本解析；无需子进程 `--mode json`；失败重试兜底 |
| U5 | tool 事件够不够 read-set | ✅ 路径够，digest 不够 | 路径从 `tool_call` 免费拿；hash 由 runner 对 `tool_result.content` 自算（Phase 4）|
| §8.6 | MCP SDK 依赖 | （设计项，非 spike）| 保持 §9/D16：`@modelcontextprotocol/sdk` 提为 bridge 直接依赖 |

## 5. 复现方式

```bash
# 需 Node ≥ 20（pi-tui 用 v regex flag）；本次用 22.17.0
cd spikes/phase0
npm install
export WEA_BASE_URL=... WEA_API_KEY=... WEA_MODEL=...   # 见本地 .env（git 忽略）
node connectivity-test.mjs   # 期望：reply "PONG" + 完整 usage
node spike.mjs               # 期望：U1–U5 全绿，3 distinct session ids
```
