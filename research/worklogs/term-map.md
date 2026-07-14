# Term Map

> Topic: 基于图结构 Workflow IR 的自进化 Coding Agent
> Last updated: 2026-07-13

## Terms

| User term | Research term | Synonyms / query keywords | Operational definition | Canonical sources | Notes |
|---|---|---|---|---|---|
| 调用树→图 | agent execution graph | agent graph, dynamic DAG, dataflow MAS, graph of agents | 节点为可观测执行单元，边显式表达 data/control/communication | GoT, GPTSwarm, LLMCompiler | 必须区分 logical graph 与 runtime trace graph |
| Workflow IR | executable agent workflow IR | workflow DSL, graph IR, agentic system code, routine memory | 可版本化、实例化、验证、执行和编辑的中间表示 | AWM, ADAS, DSPy, LangGraph | “IR”不是仅可读文本 |
| 无重跑归因 | observational / trace-only attribution | provenance, contribution tracing, influence proxy, causal attribution | 不重新执行被删节点，仅从一次 trace 估计价值 | DyLAN/AgentPrune 等 | 只能声称 proxy，除非经反事实校准 |
| 安全语义去重 | sound semantic memoization | semantic cache, task equivalence, proof-carrying cache | 复用前满足输入/依赖/权限/时效/输出契约 | build systems, semantic caching | 默认 exact safe，semantic opt-in |
| 自进化 | online workflow optimization | self-improving agents, archive search, champion-challenger | 根据历史证据提议新模板，经门禁后晋级 | ADAS, DGM, Gödel Agent | 与模型权重自修改区分 |
| 子图蒸馏 | frequent/high-value subgraph mining | workflow induction, routine extraction, motif mining | 多 trace 对齐后抽取高价值重复结构并参数化 | AWM + graph mining | 频繁不等于有价值 |
| per-task 微调 | query-conditioned workflow adaptation | graph editing, architecture search, workflow synthesis | 在模板上受约束地增删改节点/边/参数 | MaAS, GPTSwarm | 先限制 action space |

## Query expansions

- Term: single-trace contribution attribution
  - keywords: data provenance, causal attribution proxy, agent importance, removal-based attribution, information flow
  - related benchmarks/datasets: SWE-bench, AgentBench, multi-agent traces
  - adjacent fields: causal inference, program slicing, provenance semirings, observability
  - Google Scholar queries: "multi-agent credit assignment LLM agents", "trace based contribution attribution workflow"
  - arXiv queries/categories: cs.AI, cs.LG, cs.SE; agent pruning attribution
  - sciencehub lookup keys: verified arXiv/DOI only
- Term: sound semantic reuse
  - keywords: semantic caching false positives, incremental build invalidation, hermetic build, cache key dependency closure
  - related benchmarks/datasets: code repositories with commit-level tasks
  - adjacent fields: build systems, databases/materialized views, memoization, reproducible builds
  - Google Scholar queries: "semantic cache correctness LLM", "incremental build dependency invalidation"
  - arXiv queries/categories: cs.SE, cs.DC, cs.CL
  - sciencehub lookup keys: Build Systems à la Carte; SGLang
- Term: self-evolving workflow graph
  - keywords: automated agent design, self-improving coding agent, agent architecture search, workflow memory
  - related benchmarks/datasets: SWE-bench Verified, GAIA, HumanEval variants
  - adjacent fields: AutoML/NAS, program synthesis, bandits, safe deployment
  - Google Scholar queries: "automated design agentic systems workflow", "self improving coding agent workflow graph"
  - arXiv queries/categories: cs.AI, cs.SE, cs.LG
  - sciencehub lookup keys: ADAS, DGM, Gödel Agent, AWM
