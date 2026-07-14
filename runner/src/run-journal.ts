/**
 * Run journal — durable, step-by-step decision log for every WEA run.
 *
 * Layout (under --out / <runDir>):
 *   journal.jsonl     append-only event stream (one JSON object per line)
 *   console.log       human-readable mirror of console lines
 *   plan.json         pre-run routing decision + chosen graph
 *   graph.initial.json
 *   graph.<phase>.json   after handoff / replan
 *   handoff.<n>.json
 *   replan.<n>.json
 *   improve.json
 *   nodes/<nodeId>.attempt-<n>.json
 *   summary.md
 *   meta.json         run identity / paths
 *
 * Consumers: CLI (run.ts), GUI (optional), post-hoc audit.
 */

import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunEvent } from "./orchestrator.ts";
import type { WorkflowGraph } from "./types.ts";

export interface JournalMeta {
	runDir: string;
	runId?: string;
	task: string;
	templateRef?: string;
	mode: string;
	startedAt: string;
	endedAt?: string;
	status?: string;
	cliArgs?: Record<string, unknown>;
}

export class RunJournal {
	readonly runDir: string;
	private handoffN = 0;
	private replanN = 0;
	private lines = 0;
	private meta: JournalMeta;
	private graphs: { phase: string; graph: WorkflowGraph; at: string }[] = [];
	private planWritten = false;

	constructor(opts: {
		outRoot: string;
		task: string;
		mode: string;
		templateRef?: string;
		cliArgs?: Record<string, unknown>;
		/** Optional fixed run dir name; default: timestamp + random. */
		runDirName?: string;
	}) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const short = Math.random().toString(36).slice(2, 8);
		const name = opts.runDirName ?? `${stamp}-${short}`;
		this.runDir = join(opts.outRoot, name);
		mkdirSync(this.runDir, { recursive: true });
		mkdirSync(join(this.runDir, "nodes"), { recursive: true });
		mkdirSync(join(this.runDir, "graphs"), { recursive: true });
		this.meta = {
			runDir: this.runDir,
			task: opts.task,
			mode: opts.mode,
			templateRef: opts.templateRef,
			startedAt: new Date().toISOString(),
			cliArgs: opts.cliArgs,
		};
		this.writeJson("meta.json", this.meta);
		this.append({
			type: "journal_open",
			at: this.meta.startedAt,
			task: opts.task,
			mode: opts.mode,
			templateRef: opts.templateRef,
			runDir: this.runDir,
		});
	}

	/** Human + machine log line. */
	log(message: string): void {
		const line = `[${ts()}] ${message}`;
		console.log(line);
		appendFileSync(join(this.runDir, "console.log"), line + "\n");
		this.append({ type: "console", at: new Date().toISOString(), message });
	}

	/** Raw console without journal type noise (still mirrored). */
	print(message: string): void {
		console.log(message);
		appendFileSync(join(this.runDir, "console.log"), message + "\n");
	}

	append(record: Record<string, unknown>): void {
		const row = { seq: ++this.lines, at: new Date().toISOString(), ...record };
		appendFileSync(join(this.runDir, "journal.jsonl"), JSON.stringify(row) + "\n");
	}

	writeJson(name: string, value: unknown): void {
		const path = join(this.runDir, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
	}

	writeText(name: string, text: string): void {
		const path = join(this.runDir, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text.endsWith("\n") ? text : text + "\n");
	}

	/** Handle a RunEvent from the orchestrator — full decision trail. */
	onEvent(e: RunEvent): void {
		// Always persist the raw event
		this.append({ type: "event", event: e });

		switch (e.type) {
			case "template_resolved":
				this.log(`[plan] ${e.planMode ?? "?"} → ${e.templateRef}`);
				this.log(`[plan] ${e.why}`);
				this.append({
					type: "decision",
					kind: "template_resolved",
					planMode: e.planMode,
					templateRef: e.templateRef,
					why: e.why,
				});
				break;

			case "plan_detail":
				this.writePlan({
					mode: e.mode,
					baseId: e.baseId,
					version: e.version,
					why: e.why,
					graph: e.graph,
					writtenPath: e.writtenPath,
					controlUsage: e.controlUsage,
					decision: e.decision,
					candidates: e.candidates,
				});
				break;

			case "run_started":
				this.meta.runId = e.runId;
				this.meta.templateRef = e.templateRef;
				this.writeJson("meta.json", this.meta);
				this.writeJson("graphs/graph.current.json", e.graph);
				if (!existsSync(join(this.runDir, "graphs", "graph.initial.json"))) {
					this.writeJson("graphs/graph.initial.json", e.graph);
				}
				this.graphs.push({ phase: e.templateRef, graph: e.graph, at: new Date().toISOString() });
				this.log(
					`sealed ${e.graph.nodes.length} nodes; starting (${e.mode}) template=${e.templateRef}`,
				);
				if (e.workerModel) this.log(`workers: ${e.workerModel}`);
				if (e.controlModel) this.log(`control: ${e.controlModel}`);
				this.log(`nodes: ${e.graph.nodes.map((n) => `${n.id}(${n.agentCard})`).join(" → ")}`);
				this.append({
					type: "decision",
					kind: "graph_sealed",
					runId: e.runId,
					templateRef: e.templateRef,
					templateVersion: e.templateVersion,
					nodeIds: e.graph.nodes.map((n) => n.id),
					edgeIds: e.graph.edges.map((x) => x.id),
					workerModel: e.workerModel,
					controlModel: e.controlModel,
				});
				break;

			case "node_state":
				if (e.state === "FAILED") this.log(`✘ ${e.nodeId} ${e.detail ?? ""}`);
				else if (e.state === "RUNNING") this.log(`… ${e.nodeId} running (attempt ${e.attemptNo})`);
				break;

			case "loop":
				this.log(`↺ loop ${e.loopId} iter=${e.iteration}${e.exhausted ? " EXHAUSTED" : ""}`);
				break;

			case "node_activity":
				// Keep journal complete but avoid flooding console
				this.append({
					type: "activity",
					nodeId: e.nodeId,
					attemptNo: e.attemptNo,
					activity: e.activity,
				});
				break;

			case "node_result": {
				const mark = e.status === "success" ? "✔" : "✘";
				this.log(
					`${mark} ${e.nodeId} ${e.status}  tokens=${e.tokens} tools=${e.toolCalls}  ${e.summary.slice(0, 120)}`,
				);
				this.writeJson(`nodes/${safe(e.nodeId)}.attempt-${e.attemptNo}.json`, {
					nodeId: e.nodeId,
					attemptNo: e.attemptNo,
					status: e.status,
					summary: e.summary,
					tokens: e.tokens,
					costMicrounits: e.costMicrounits,
					toolCalls: e.toolCalls,
					output: e.output,
					error: e.error,
				});
				break;
			}

			case "escalation":
				this.log(`⚠ ESCALATE ${e.nodeId}: ${e.reason}`);
				this.writeJson(`escalation.${safe(e.nodeId)}.json`, e);
				this.append({
					type: "decision",
					kind: "escalation",
					nodeId: e.nodeId,
					reason: e.reason,
					attemptNo: e.attemptNo,
				});
				break;

			case "master_replan": {
				this.replanN += 1;
				this.log(`[master-replan #${this.replanN}] ${e.ok ? "ok" : "fail"} ${e.why}`);
				this.writeJson(`replan.${this.replanN}.json`, {
					ok: e.ok,
					why: e.why,
					templateRef: e.templateRef,
					graph: e.graph ?? null,
				});
				if (e.ok && e.graph) {
					this.writeJson(`graphs/graph.replan-${this.replanN}.json`, e.graph);
					this.writeJson("graphs/graph.current.json", e.graph);
					this.graphs.push({
						phase: `replan-${this.replanN}`,
						graph: e.graph,
						at: new Date().toISOString(),
					});
					this.log(
						`  new graph nodes: ${e.graph.nodes.map((n) => n.id).join(" → ")}`,
					);
				}
				this.append({
					type: "decision",
					kind: "master_replan",
					n: this.replanN,
					ok: e.ok,
					why: e.why,
					templateRef: e.templateRef,
					nodeIds: e.graph?.nodes.map((n) => n.id),
				});
				break;
			}

			case "master_handoff": {
				this.handoffN += 1;
				this.log(`[master-handoff #${this.handoffN}] ${e.ok ? "ok" : "fail"} @ ${e.nodeId}: ${e.why}`);
				this.writeJson(`handoff.${this.handoffN}.json`, {
					nodeId: e.nodeId,
					ok: e.ok,
					why: e.why,
					templateRef: e.templateRef,
					masterPlan: e.masterPlan ?? null,
					editGraph: e.editGraph ?? null,
				});
				if (e.masterPlan) {
					this.writeText(`handoff.${this.handoffN}.master_plan.txt`, e.masterPlan);
					const preview = e.masterPlan.slice(0, 600);
					this.log(`[master-plan]\n${preview}${e.masterPlan.length > 600 ? "\n…" : ""}`);
				}
				if (e.ok && e.editGraph) {
					this.writeJson(`graphs/graph.handoff-${this.handoffN}.json`, e.editGraph);
					this.writeJson("graphs/graph.current.json", e.editGraph);
					this.graphs.push({
						phase: `handoff-${this.handoffN}`,
						graph: e.editGraph,
						at: new Date().toISOString(),
					});
					this.log(
						`  edit graph: ${e.editGraph.nodes.map((n) => n.id).join(" → ")}`,
					);
				}
				this.append({
					type: "decision",
					kind: "master_handoff",
					n: this.handoffN,
					nodeId: e.nodeId,
					ok: e.ok,
					why: e.why,
					templateRef: e.templateRef,
					hasPlan: !!e.masterPlan,
					editNodeIds: e.editGraph?.nodes.map((n) => n.id),
				});
				break;
			}

			case "master_improve":
				this.log(
					`[master-improve] ${e.ok ? "ok" : "fail"} applied=${e.applied} ${e.why}`,
				);
				this.writeJson("improve.json", e);
				this.append({
					type: "decision",
					kind: "master_improve",
					ok: e.ok,
					applied: e.applied,
					why: e.why,
					writtenPath: e.writtenPath,
				});
				break;

			case "workspace_prepared":
				this.log(`[workspace] isolated worktree ${e.worktree}`);
				this.log(`[workspace] baseline ${e.baselineCommit}${e.sourceWasDirty ? " (includes source dirty state)" : ""}`);
				this.writeJson("workspace.prepared.json", e);
				break;

			case "workspace_result":
				this.log(`[workspace] ${e.changedFiles.length} changed file(s); ${e.note}`);
				if (e.patchPath) this.log(`[workspace] patch ${e.patchPath}`);
				this.writeJson("workspace.result.json", e);
				break;

			case "budget":
				this.append({ type: "budget", tokensUsed: e.tokensUsed, costMicrounits: e.costMicrounits });
				break;

			case "log":
				this.log(e.message);
				break;

			case "run_done": {
				this.meta.endedAt = new Date().toISOString();
				this.meta.status = e.status;
				this.writeJson("meta.json", this.meta);
				this.log("");
				this.log(`done status=${e.status}`);
				this.log(`tokens=${e.tokens}  cost=$${(e.costMicrounits / 1e6).toFixed(4)}`);
				for (const f of e.files) this.log(`wrote ${f}`);
				this.writeSummary(e);
				break;
			}
		}
	}

	/** Persist full plan result (decision JSON + graph) once available. */
	writePlan(plan: {
		mode: string;
		baseId: string;
		version: string;
		why: string;
		graph: WorkflowGraph;
		writtenPath?: string;
		controlUsage?: { inputTokens: number; outputTokens: number };
		decision?: Record<string, unknown>;
		candidates?: unknown;
	}): void {
		this.planWritten = true;
		this.writeJson("plan.json", {
			mode: plan.mode,
			baseId: plan.baseId,
			version: plan.version,
			why: plan.why,
			writtenPath: plan.writtenPath ?? null,
			controlUsage: plan.controlUsage ?? null,
			decision: plan.decision ?? null,
			candidates: plan.candidates ?? null,
			graph: plan.graph,
		});
		this.writeJson("graphs/graph.planned.json", plan.graph);
		this.append({
			type: "decision",
			kind: "plan",
			mode: plan.mode,
			baseId: plan.baseId,
			version: plan.version,
			why: plan.why,
			decision: plan.decision ?? null,
			nodeIds: plan.graph.nodes.map((n) => n.id),
		});
		this.log(
			`[plan-detail] mode=${plan.mode} base=${plan.baseId}@${plan.version} nodes=${plan.graph.nodes.length}`,
		);
		if (plan.decision) {
			this.log(`[plan-decision] ${JSON.stringify(plan.decision).slice(0, 400)}…`);
		}
	}

	/** Copy orchestrator-written files into journal dir (trace/manifest). */
	noteArtifacts(files: string[]): void {
		this.writeJson("artifacts.json", { files });
		this.append({ type: "artifacts", files });
	}

	private writeSummary(e: Extract<RunEvent, { type: "run_done" }>): void {
		const md = [
			`# WEA run summary`,
			``,
			`- **status:** ${e.status}`,
			`- **task:** ${JSON.stringify(this.meta.task)}`,
			`- **template:** ${this.meta.templateRef ?? "?"}`,
			`- **mode:** ${this.meta.mode}`,
			`- **runId:** ${this.meta.runId ?? "?"}`,
			`- **started:** ${this.meta.startedAt}`,
			`- **ended:** ${this.meta.endedAt}`,
			`- **tokens:** ${e.tokens}`,
			`- **cost:** $${(e.costMicrounits / 1e6).toFixed(4)}`,
			`- **journal lines:** ${this.lines}`,
			`- **handoffs:** ${this.handoffN}`,
			`- **replans:** ${this.replanN}`,
			``,
			`## Graph phases`,
			...this.graphs.map(
				(g, i) =>
					`${i + 1}. **${g.phase}** @ ${g.at} — nodes: ${g.graph.nodes.map((n) => n.id).join(" → ")}`,
			),
			``,
			`## Artifacts`,
			`- \`journal.jsonl\` — full event stream`,
			`- \`console.log\` — human log`,
			`- \`plan.json\` — control routing decision`,
			`- \`graphs/\` — graph snapshots`,
			`- \`nodes/\` — per-node outputs`,
			`- \`handoff.*.json\` / \`replan.*.json\` / \`improve.json\``,
			`- \`workspace.*.json\` — isolated worktree and review-only patch metadata`,
			``,
			`## Orchestrator files`,
			...e.files.map((f) => `- \`${f}\``),
			``,
		].join("\n");
		writeFileSync(join(this.runDir, "summary.md"), md);
		this.append({ type: "journal_close", status: e.status, lines: this.lines });
	}
}

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

function safe(s: string): string {
	return s.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function defaultRunsDir(cwd = process.cwd()): string {
	// Prefer repo-local runner/runs when invoked from runner/, else ./runs
	const candidate = join(cwd, "runs");
	return candidate;
}
