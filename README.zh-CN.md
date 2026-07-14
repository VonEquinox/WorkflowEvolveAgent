# WorkflowEvolveAgent（中文说明）

一个**可观测、可复用、可自演化**的 coding-agent 工作流系统，基于 **pi SDK**（`@earendil-works/pi-coding-agent`）用纯 TypeScript 实现。

它把一次 coding 任务跑成一张**多智能体图**：调度 → 记录 trace → 归因 → 检索合适工作流 → 安全复用纯结果 → 让 meta-agent 改流程 → **只有实测打赢当前冠军才晋升**。另附 MCP-over-bash 桥，让节点能用外部 MCP 工具而不把大体量结果灌进上下文。

> 运行时：pi SDK · Node ≥ 20 · TypeScript  
> 模型端点：任意 **Anthropic Messages 兼容** API  
> 英文文档：[README.md](./README.md)

---

## 它是什么 / 不是什么

| 是 | 不是 |
|----|------|
| 基于 pi **SDK** 的 workflow **运行时**（CLI + Web GUI） | 交互式 `pi` TUI 的官方插件（当前不能 `pi install` 后直接 `/wea`） |
| 每个图节点 = 一次无界面 `createAgentSession` | 和你正在聊的那个 pi 会话共享上下文 |
| 用图编排多个短生命周期 agent | “多 agent 一定更省 token”的魔法 |

**结合 pi 的方式：** WEA 当主机，在进程内调用 pi SDK 执行每个节点。  
**不是：** 把 WEA 嵌进交互式 pi 聊天窗口里跑。

---

## 仓库结构

```
runner/        @wea/runner — 执行 + 演化运行时
  src/
    graph.ts           事件驱动调度（ALL/ANY_SUCCESS、SEAL、有界回环、重试）
    node-session.ts    节点 ↔ pi AgentSession
    recorder-ext.ts    旁路捕获工具/用量/脱敏
    orchestrator.ts    CLI 与 GUI 共用的执行循环（live + sim）
    run.ts             CLI 入口
    gui-server.ts      本地 Web UI（SSE 实时事件）
    retrieval.ts       任务 → 选模板
    cache.ts           只读精确复用（fail-closed）
    meta-improve.ts    复盘 → 改图提案 → challenger
    champion.ts        配对实测，决定是否晋升
  gui/                 前端静态资源

library/       工作流库（版本化、进 git）
  templates/   t0-direct · t1-safe-generic · t2-bugfix · t3-complex
  agents/      inspector · implementer · verifier · explorer · aggregator · meta-improver

mcp-bridge/    @wea/mcp-bridge — 经 bash 调用 MCP，大结果落盘再 rg/jq
install.sh     一键安装（依赖 + 离线自测）
```

组件细读：[`runner/README.md`](./runner/README.md)、[`mcp-bridge/README.md`](./mcp-bridge/README.md)。

---

## 一键安装

```bash
git clone https://github.com/VonEquinox/WorkflowEvolveAgent.git
cd WorkflowEvolveAgent
chmod +x install.sh
./install.sh
```

常用参数：

```bash
./install.sh --skip-test   # 只装依赖
./install.sh --gui         # 装完并启动 Web GUI
./install.sh --help
```

脚本会：

1. 检查 Node ≥ 20  
2. `npm install` runner 与 mcp-bridge  
3. 写入 / 确认 `.env.example`  
4. 跑离线自测（不花 API）：runner Phases 3–5 + smoke，mcp-bridge e2e  

---

## 快速开始

### 1）离线演示（无需模型）

```bash
cd runner
npm run gui
# 浏览器打开 http://127.0.0.1:7788
# 选 Simulate → 输入任务 → 看 live DAG 与各 agent 进度
```

或命令行：

```bash
cd runner && npm test && npm run smoke
```

### 2）真跑（Live）

需要 Anthropic-messages 兼容端点：

```bash
cp .env.example .env
# 编辑 .env：WEA_BASE_URL / WEA_API_KEY / WEA_MODEL

set -a && source .env && set +a
cd runner
npx tsx src/run.ts \
  --task "node test.js fails: 修掉 off-by-one" \
  --template auto \
  --repo /path/to/target-repo \
  --out runs
```

输出：

| 文件 | 含义 |
|------|------|
| `runs/*.trace.json` | 合规 trace（`wea.trace/v1`） |
| `runs/*.pvf.json` | 归因输入（`wea.pvf.trace/v1`） |
| `runs/*.manifest.json` | 完整内部记录，可离线 rebuild |

GUI Live：先 export `WEA_*`，再 `npm run gui`，界面会显示 live 可用。

### 3）MCP 桥（可选）

```bash
cd mcp-bridge
npm test
bash scripts/e2e.sh
```

> 注意：把 bridge 挂进 runner 节点会话的接线仍在 pending 列表中；桥本身已可独立验证。

---

## 工作流模板（冷启动）

| 模板 | 结构 | 适用 |
|------|------|------|
| `t0-direct` | 勘察 → 实现 → 验证 | 最简单直接 |
| `t1-safe-generic` | 同上 + 有界修复环 | 通用默认 |
| `t2-bugfix` | 定位 → 补丁 → 回归 + 修复环 | 修 bug |
| `t3-complex` | 双探索 → 聚合 → 实现 → 验证 + 修复环 | 复杂任务 |

`--template auto` 时由 **retrieval** 按任务选型；若该家族有 champion 版本，自动用晋升版。

---

## 和 pi 怎么一起用？

### 当前官方路径（推荐）

```text
你 → WEA CLI / GUI
        → orchestrator 调度图
            → 每节点 createAgentSession（pi SDK）
            → 模型用 pi 内置工具 read/edit/bash/...
        → 写出 trace
```

- **不需要**先开交互式 `pi`  
- **不会**改你的 `~/.pi/agent` 配置  
- 模型鉴权走 **`WEA_*`**，与 pi 的 provider 设置分离  

### 和日常 pi 的分工建议

| 场景 | 用谁 |
|------|------|
| 闲聊、小改动、探索代码 | 交互式 `pi` |
| 多步 bugfix / 加功能、要 trace 与图调度 | WEA CLI 或 GUI |
| 只要 MCP 大结果不进上下文 | mcp-bridge（或挂进 session 后） |

### 尚未提供

- `pi install` 后在 TUI 里 `/wea` 的官方 extension  
- 自动读取 `~/.pi` 的 defaultProvider 填 `WEA_*`  

若需要，可自行加一层薄 pi extension：注册 `/wea`，子进程调用本仓库 `run.ts`。

---

## 自演化（L4）怎么理解

```text
跑任务 → 留 IR/trace
      → meta-improver 看复盘 + 当前图 → wea.proposal/v2
      → 结构门（只检查“能不能跑”）
      → 写出 challenger：templates/<id>@<ver>.json
      → 配对实测 → champion 门
            赢：改 alias，以后默认用新图
            输：旧冠军不动，challenger 归档
```

**信任模型（D28）：** meta-agent 可以大胆改图（甚至删 verifier）；安全不靠禁止想法，靠**测量**。原版模板永不删除。

当前多为**半自动**（`meta-improve` / champion 分步），不是每次 run 后全自动进化。

---

## 省 token 吗？

**不保证**“多节点一定比单个 pi 便宜”。  
更可能省在：

1. 短会话 + JSON 摘要，减少长上下文重复  
2. 角色工具裁剪，减少乱试  
3. 只读 exact cache  
4. MCP 大结果 `--out` 落盘  
5. 长期进化把图改瘦（需 champion 证明更省）

简单任务请用 t0/t1，不要事事 t3。

---

## 已验证 vs 待接线

**已验证**

- Live：T2 修真 bug、T3 加真功能；meta 能提出可运行 challenger  
- 离线：retrieval / cache / champion；MCP bridge 全链路  
- GUI Simulate：真实调度器 + 桩执行，可看并行与 FEEDBACK  

**待接线（不是从零设计）**

- 多 pair 线上 A/B  
- exact cache 挂进 spawn 循环  
- MCP bridge 挂进 runner 节点 session  
- worktree 写隔离、节点级预算强制  

---

## 常用命令速查

```bash
./install.sh                  # 一键安装 + 离线测
cd runner && npm run gui      # Web UI
cd runner && npm test         # Phase 3–5
cd runner && npm run smoke    # 合成 trace
cd runner && npm run run -- --task "..." --template auto --repo ...
cd runner && npm run improve  # meta-improve（需 report + WEA_*）
cd mcp-bridge && npm test
```

---

## 安全提示

- 第三方模板 / 扩展 / MCP 权限很高，安装前先看源码  
- 试跑 challenger 应在可回滚沙箱中，避免不可逆外部副作用  
- `.env` 已在 `.gitignore`，不要提交密钥  

---

## 许可证 / 贡献

仓库见 GitHub：[VonEquinox/WorkflowEvolveAgent](https://github.com/VonEquinox/WorkflowEvolveAgent)。  
设计决策以本地 D-number 记录为准；负载最重的一条是 **D28**（用测量而非禁令保证安全）。
