/**
 * wea run — CLI entry. A thin front over the orchestrator: parse args, forward
 * events to console lines, exit non-zero on failure. The GUI server drives the
 * same orchestrator over SSE (gui-server.ts).
 *
 * Usage:
 *   WEA_BASE_URL=.. WEA_API_KEY=.. WEA_MODEL=.. \
 *     tsx src/run.ts --task "..." [--template auto|t2-bugfix|...] [--repo <dir>] [--out <dir>]
 */

import { join, resolve } from "node:path";
import { executeRun, type RunEvent } from "./orchestrator.ts";

interface CliArgs {
	task: string;
	template: string;
	family?: string;
	language?: string;
	repo: string;
	out: string;
	maxParallel: number;
}

function parseArgs(argv: string[]): CliArgs {
	const get = (flag: string, dflt?: string): string => {
		const i = argv.indexOf(flag);
		if (i >= 0 && i + 1 < argv.length) return argv[i + 1]!;
		if (dflt !== undefined) return dflt;
		throw new Error(`missing required ${flag}`);
	};
	const opt = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
	};
	return {
		task: get("--task"),
		template: get("--template", "auto"),
		family: opt("--family"),
		language: opt("--language"),
		repo: resolve(get("--repo", process.cwd())),
		out: resolve(get("--out", join(process.cwd(), "runs"))),
		maxParallel: Number(get("--max-parallel", "3")),
	};
}

function requireEnv(): { baseUrl: string; apiKey: string; modelId: string } {
	const baseUrl = process.env.WEA_BASE_URL;
	const apiKey = process.env.WEA_API_KEY;
	const modelId = process.env.WEA_MODEL;
	if (!baseUrl || !apiKey || !modelId) throw new Error("set WEA_BASE_URL / WEA_API_KEY / WEA_MODEL");
	return { baseUrl, apiKey, modelId };
}

const log = (msg: string): void => console.log(msg);

function onEvent(e: RunEvent): void {
	switch (e.type) {
		case "template_resolved":
			log(`[retrieval] ${e.why}`);
			break;
		case "run_started":
			log(`sealed ${e.graph.nodes.length} nodes; starting event loop (${e.mode})`);
			break;
		case "node_state":
			if (e.state === "FAILED") log(`✘ ${e.nodeId} ${e.detail ?? ""}`);
			break;
		case "node_result":
			if (e.status === "success") log(`✔ ${e.nodeId} ok  tokens=${e.tokens} tools=${e.toolCalls}`);
			break;
		case "log":
			log(e.message);
			break;
		case "run_done": {
			log(`\ndone status=${e.status}`);
			log(`tokens=${e.tokens}  cost=$${(e.costMicrounits / 1e6).toFixed(4)}`);
			for (const f of e.files) log(`wrote ${f}`);
			if (e.files[0]) {
				log(`validate:  python3 tools/validate_ir.py ${e.files[0]}`);
				log(`attribute: python3 prototypes/attribution.py ${e.files[1]} --pretty`);
			}
			break;
		}
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const env = requireEnv();
	const result = await executeRun({
		task: args.task,
		templateRef: args.template,
		family: args.family,
		language: args.language,
		repo: args.repo,
		out: args.out,
		maxParallel: args.maxParallel,
		mode: "live",
		env,
		onEvent,
	});
	if (result.status !== "success") process.exitCode = 1;
}

main().catch((err) => {
	console.error("RUN FAILED:", err);
	process.exit(1);
});
