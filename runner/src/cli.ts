#!/usr/bin/env node
/**
 * WEA CLI — multi-command entry.
 *
 *   wea run    --task "..." [options]     # execute a workflow (default command)
 *   wea gui    [--port 7788]              # start web GUI
 *   wea templates                         # list catalog templates
 *   wea doctor                            # check Node / WEA_* / pi
 *   wea help
 *
 * Legacy (still works):
 *   wea --task "..."   ≡  wea run --task "..."
 *
 * Every run writes a journal under --out (default: ./runs/<timestamp>-<id>/):
 * decisions, graphs, node outputs, handoffs, replans — see run-journal.ts.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
// existsSync used for plan.json backfill
import { fileURLToPath } from "node:url";
import { executeRun } from "./orchestrator.ts";
import { loadTemplateCatalog } from "./retrieval.ts";
import { defaultRunsDir, RunJournal } from "./run-journal.ts";
import { loadWeaControlConfig } from "./wea-control.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = join(HERE, "..");
const REPO_ROOT = join(RUNNER_ROOT, "..");

// ---- tiny arg helpers ---------------------------------------------------------

function flag(argv: string[], name: string): boolean {
	return argv.includes(name);
}

function opt(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function req(argv: string[], name: string, dflt?: string): string {
	const v = opt(argv, name) ?? dflt;
	if (v === undefined) throw new Error(`missing required ${name}`);
	return v;
}

function loadDotEnv(path: string): void {
	if (!existsSync(path)) return;
	const text = readFileSync(path, "utf8");
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq < 0) continue;
		const k = t.slice(0, eq).trim();
		let v = t.slice(eq + 1).trim();
		if (
			(v.startsWith('"') && v.endsWith('"')) ||
			(v.startsWith("'") && v.endsWith("'"))
		) {
			v = v.slice(1, -1);
		}
		if (process.env[k] === undefined) process.env[k] = v;
	}
}

function tryLoadEnv(): void {
	// repo root .env, then cwd .env
	loadDotEnv(join(REPO_ROOT, ".env"));
	loadDotEnv(join(process.cwd(), ".env"));
}

// ---- help ---------------------------------------------------------------------

const HELP = `WEA — WorkflowEvolveAgent CLI

Usage:
  wea run --task <text> [options]
  wea gui [--port <n>]
  wea templates
  wea doctor
  wea help

Commands:
  run         Execute a workflow graph (default if --task is given)
  gui         Start the web GUI (default port 7788)
  templates   List catalog workflow templates
  doctor      Check Node, WEA_* control env, and pi defaults
  help        Show this help

run options:
  --task <text>              Task description (required)
  --template <id|auto>       Template id or "auto" (default: auto)
  --repo <dir>               Working repo for workers (default: cwd)
  --out <dir>                Runs root; each run gets a subdir journal (default: ./runs)
  --mode live|sim            live = real models; sim = offline stub (default: live)
  --family <name>            Optional task family hint (bugfix|feature|…)
  --language <lang>          Optional language hint
  --max-parallel <n>         Max concurrent nodes (default: 3)
  --offline-plan             Skip control LLM; BM25 template pick only
  --no-replan                Disable escalate→master replan loop
  --no-improve               Disable post-run process improve
  --no-persist               Do not write adapted/challenger templates
  -q, --quiet                Less console noise (journal still full)

Examples:
  wea run --task "fix the flaky timeout in auth tests" --template auto
  wea run --task "add health check" --template t-explore-master-implement --mode sim
  wea run --task "..." --repo ~/proj --out ~/proj/.wea-runs
  wea gui
  wea templates

Journal (every run):
  <out>/<timestamp>-<id>/
    journal.jsonl   full event stream (decisions, graphs, nodes)
    console.log     human-readable log
    plan.json       control routing decision + graph
    graphs/         initial / handoff / replan snapshots
    nodes/          per-node JSON outputs
    summary.md      short human summary
`;

// ---- commands -----------------------------------------------------------------

async function cmdRun(argv: string[]): Promise<void> {
	tryLoadEnv();

	if (flag(argv, "-h") || flag(argv, "--help")) {
		console.log(HELP);
		return;
	}

	const task = req(argv, "--task");
	const template = req(argv, "--template", "auto");
	const repo = resolve(req(argv, "--repo", process.cwd()));
	const outRoot = resolve(req(argv, "--out", defaultRunsDir(process.cwd())));
	const mode = (req(argv, "--mode", "live") as "live" | "sim");
	if (mode !== "live" && mode !== "sim") throw new Error(`--mode must be live|sim, got ${mode}`);
	const family = opt(argv, "--family");
	const language = opt(argv, "--language");
	const maxParallel = Number(req(argv, "--max-parallel", "3"));
	const offlinePlan = flag(argv, "--offline-plan");
	const quiet = flag(argv, "-q") || flag(argv, "--quiet");
	const enableReplan = !flag(argv, "--no-replan");
	const enableImprove = !flag(argv, "--no-improve");
	const persist = !flag(argv, "--no-persist");

	const journal = new RunJournal({
		outRoot,
		task,
		mode,
		templateRef: template,
		cliArgs: {
			task,
			template,
			repo,
			outRoot,
			mode,
			family,
			language,
			maxParallel,
			offlinePlan,
			enableReplan,
			enableImprove,
			persist,
		},
	});

	journal.log(`WEA run journal → ${journal.runDir}`);
	journal.log(`task: ${task}`);
	journal.log(`template: ${template}  mode: ${mode}  repo: ${repo}`);

	const control = offlinePlan || mode === "sim" ? null : loadWeaControlConfig();
	if (template === "auto" && !control && mode === "live") {
		journal.log("[warn] WEA_* not set — auto plan uses offline BM25; workers still use pi default");
	}
	if (control) {
		journal.log(`[control] ${control.modelId} @ ${control.baseUrl}`);
	}

	// Orchestrator still writes trace/manifest under outRoot; journal is the
	// structured step log in a dedicated subdir.
	const result = await executeRun({
		task,
		templateRef: template,
		family,
		language,
		repo,
		out: outRoot,
		maxParallel,
		mode,
		control,
		offlinePlan,
		persistPlan: persist,
		persistImprove: persist,
		enableEscalationReplan: enableReplan,
		enablePostRunImprove: enableImprove,
		onEvent: (e) => {
			if (quiet && e.type === "node_activity") {
				// still journal, skip extra console via direct append path —
				// RunJournal.onEvent already quiets activity console.
			}
			journal.onEvent(e);
			// Capture plan detail when template resolves with plan mode
			if (e.type === "template_resolved" && e.planMode && e.planMode !== "explicit") {
				// plan.json written after executeRun via result.plan
			}
		},
	});

	// plan.json is written from plan_detail during the run; backfill if missing
	if (result.plan && !existsSync(join(journal.runDir, "plan.json"))) {
		journal.writePlan({
			mode: result.plan.mode,
			baseId: result.plan.baseId,
			version: result.plan.version,
			why: result.plan.why,
			graph: result.plan.graph,
			writtenPath: result.plan.writtenPath,
			controlUsage: result.plan.controlUsage,
			decision: result.plan.decision,
			candidates: result.plan.candidates,
		});
	}
	if (result.files?.length) journal.noteArtifacts(result.files);

	journal.log(`journal directory: ${journal.runDir}`);
	console.log(`\n📁 Full decision log: ${journal.runDir}`);
	console.log(`   summary: ${join(journal.runDir, "summary.md")}`);
	console.log(`   stream:  ${join(journal.runDir, "journal.jsonl")}`);

	if (result.status !== "success") process.exitCode = 1;
}

function cmdTemplates(): void {
	const catalog = loadTemplateCatalog();
	console.log(`Catalog templates (${catalog.length}):\n`);
	for (const t of catalog.sort((a, b) => a.id.localeCompare(b.id))) {
		const nodes = t.graph.nodes.map((n) => n.id).join(" → ");
		console.log(`  ${t.id}  v${t.version}`);
		console.log(`    ${t.summary}`);
		console.log(`    nodes: ${nodes}`);
		console.log();
	}
	console.log(`Tip: stage subgraphs with "catalog": false are hidden (e.g. t-implement-verify).`);
	console.log(`     Use --template <id> to force any loadable template by id.`);
}

function cmdDoctor(): void {
	tryLoadEnv();
	console.log("WEA doctor\n");
	console.log(`  Node: ${process.version}`);
	console.log(`  cwd:  ${process.cwd()}`);
	console.log(`  repo: ${REPO_ROOT}`);

	const control = loadWeaControlConfig();
	if (control) {
		console.log(`  WEA control: ${control.modelId}`);
		console.log(`    baseUrl: ${control.baseUrl}`);
		console.log(`    apiKey:  ${control.apiKey ? control.apiKey.slice(0, 6) + "…" : "(empty)"}`);
	} else {
		console.log("  WEA control: NOT configured (set WEA_BASE_URL / WEA_API_KEY / WEA_MODEL)");
	}

	const piSettings = join(process.env.HOME ?? "", ".pi/agent/settings.json");
	if (existsSync(piSettings)) {
		try {
			const s = JSON.parse(readFileSync(piSettings, "utf8"));
			console.log(`  pi settings: ${piSettings}`);
			console.log(`    default model hints: ${JSON.stringify(s.defaultModel ?? s.model ?? s).slice(0, 120)}`);
		} catch {
			console.log(`  pi settings: present but unreadable at ${piSettings}`);
		}
	} else {
		console.log(`  pi settings: not found at ${piSettings} (workers need interactive pi config)`);
	}

	const catalog = loadTemplateCatalog();
	console.log(`  templates: ${catalog.length} in catalog`);
	console.log("\nOK — run: wea run --task \"...\" --mode sim");
}

function cmdGui(argv: string[]): void {
	tryLoadEnv();
	const port = opt(argv, "--port") ?? process.env.WEA_GUI_PORT ?? "7788";
	process.env.WEA_GUI_PORT = port;
	const server = join(HERE, "gui-server.ts");
	const localTsx = join(RUNNER_ROOT, "node_modules", ".bin", "tsx");
	console.log(`Starting WEA GUI on http://127.0.0.1:${port}`);
	console.log(`(loading .env from ${REPO_ROOT}/.env if present)\n`);
	const cmd = existsSync(localTsx) ? localTsx : "npx";
	const args = existsSync(localTsx) ? [server] : ["tsx", server];
	const child = spawn(cmd, args, {
		stdio: "inherit",
		env: process.env,
		cwd: RUNNER_ROOT,
		shell: cmd === "npx",
	});
	child.on("exit", (code) => process.exit(code ?? 1));
}

// ---- main ---------------------------------------------------------------------

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const head = argv[0];

	// no args / help
	if (argv.length === 0 || head === "help" || head === "-h" || head === "--help") {
		console.log(HELP);
		return;
	}

	// explicit commands
	if (head === "run") {
		await cmdRun(argv.slice(1));
		return;
	}
	if (head === "gui") {
		cmdGui(argv.slice(1));
		return;
	}
	if (head === "templates" || head === "list-templates") {
		cmdTemplates();
		return;
	}
	if (head === "doctor") {
		cmdDoctor();
		return;
	}

	// legacy: wea --task ...  or wea --mode sim ...
	if (head?.startsWith("-")) {
		await cmdRun(argv);
		return;
	}

	console.error(`Unknown command: ${head}\n`);
	console.log(HELP);
	process.exit(2);
}

main().catch((err) => {
	console.error("WEA CLI FAILED:", err);
	process.exit(1);
});
