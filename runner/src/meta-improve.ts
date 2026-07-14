/**
 * wea meta-improve — the redesign step.
 *
 * Reads a postmortem report + a runner template, runs the meta-improver pi
 * session to get a wea.proposal/v2 redesign, checks only that the redesign
 * EXECUTES (structural gate — not a safety review), and — if it runs — writes it
 * as a CHALLENGER version library/templates/<id>@<newversion>.json (the original
 * <id>.json is never mutated).
 *
 * The meta-agent is trusted: it may redesign the template however it judges
 * best, including removing verifiers or rebuilding the whole graph. Nothing here
 * vetoes an idea for being "unsafe". A redesign earns the champion slot only by
 * winning a paired comparison against the current template; if it loses, the
 * system keeps the current one. Power comes from winning the measurement.
 *
 * Usage:
 *   WEA_BASE_URL=.. WEA_API_KEY=.. WEA_MODEL=.. \
 *     tsx src/meta-improve.ts --report <postmortem.json> --template t3-complex \
 *       [--out library/templates] [--apply]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BudgetLedger } from "./budget.ts";
import { loadAgentCards, loadTemplate } from "./library.ts";
import { runNode, SessionFactory } from "./node-session.ts";
import {
	applyProposal,
	gateProposal,
	type Proposal,
	type RunnerTemplateDoc,
} from "./template-edit.ts";

interface Args {
	report: string;
	template: string;
	out: string;
	apply: boolean;
}

function parseArgs(argv: string[]): Args {
	const get = (flag: string, dflt?: string): string => {
		const i = argv.indexOf(flag);
		if (i >= 0 && i + 1 < argv.length) return argv[i + 1]!;
		if (dflt !== undefined) return dflt;
		throw new Error(`missing required ${flag}`);
	};
	const DEFAULT_OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "library", "templates");
	return {
		report: get("--report"),
		template: get("--template"),
		out: get("--out", DEFAULT_OUT),
		apply: argv.includes("--apply"),
	};
}

function requireEnv() {
	const baseUrl = process.env.WEA_BASE_URL;
	const apiKey = process.env.WEA_API_KEY;
	const modelId = process.env.WEA_MODEL;
	if (!baseUrl || !apiKey || !modelId) throw new Error("set WEA_BASE_URL / WEA_API_KEY / WEA_MODEL");
	return { baseUrl, apiKey, modelId };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const { baseUrl, apiKey, modelId } = requireEnv();

	const report = JSON.parse(readFileSync(args.report, "utf8"));
	const { graph, templateVersion } = loadTemplate(args.template);
	const templateDoc: RunnerTemplateDoc = {
		id: args.template,
		version: templateVersion,
		summary: report.template ?? args.template,
		graph,
	};

	const cards = loadAgentCards();
	const card = cards.get("meta-improver");
	if (!card) throw new Error("missing agent card: meta-improver");

	// The meta-agent sees the report and the current graph; no repo tools needed.
	const prompt = [
		"## Postmortem report",
		JSON.stringify(report, null, 2),
		"",
		"## Current template graph",
		JSON.stringify({ id: templateDoc.id, version: templateDoc.version, graph: templateDoc.graph }, null, 2),
		"",
		"Redesign this template to be better. Emit the wea.proposal/v2 JSON object.",
	].join("\n");

	const factory = new SessionFactory({ baseUrl, apiKey, modelId });
	const ledger = new BudgetLedger({ wallTimeMs: 5 * 60_000, modelTokens: 200_000, monetaryMicrounits: 2_000_000 });

	console.log(`[meta] asking meta-improver about ${args.template} v${templateVersion}...`);
	const now = new Date().toISOString();
	const rec = await runNode({
		nodeId: "meta-improver",
		attemptNo: 1,
		kind: "planner",
		card: { ...card, tools: [] }, // no-tools: pure reasoning over the given JSON
		taskPrompt: prompt,
		cwd: process.cwd(),
		repoRoot: process.cwd(),
		factory,
		ledger,
		timing: { plannedAt: now, readyAt: now },
	});

	if (rec.status !== "success" || !rec.output) {
		console.error(`[meta] meta-improver failed: ${rec.error?.code}: ${rec.error?.message}`);
		console.error(rec.finalText.slice(0, 500));
		process.exit(1);
	}

	const proposal = rec.output as unknown as Proposal;
	console.log("\n=== PROPOSAL ===");
	console.log(JSON.stringify(proposal, null, 2));

	const gate = gateProposal(templateDoc, proposal);
	console.log("\n=== GATE (structural executability only) ===");
	if (gate.ok) {
		console.log("RUNNABLE — the redesign produces an executable template. Whether it is BETTER is decided by the A/B comparison, not here.");
	} else {
		console.log("NOT RUNNABLE (would not execute):");
		for (const v of gate.violations) console.log("  · " + v);
	}

	if (gate.ok && (proposal.edits?.length ?? 0) > 0 && args.apply) {
		const next = applyProposal(templateDoc, proposal);
		const outPath = join(args.out, `${next.id}@${next.version}.json`);
		writeFileSync(outPath, JSON.stringify(next, null, 2) + "\n");
		console.log(`\n[meta] challenger written → ${outPath} (v${next.version})`);
		console.log(`[meta] champion gate:  run ${next.id}@${next.version} vs ${next.id} on the same task; it replaces the champion only if it wins.`);
	} else if (gate.ok && (proposal.edits?.length ?? 0) === 0) {
		console.log("\n[meta] proposal is 'no change' — nothing to apply.");
	} else if (!args.apply && gate.ok) {
		console.log("\n[meta] gate passed; re-run with --apply to write the new version.");
	}
}

main().catch((err) => {
	console.error("META-IMPROVE FAILED:", err);
	process.exit(1);
});
