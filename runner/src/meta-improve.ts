/**
 * wea meta-improve — post-run redesign step (control plane).
 *
 * Uses the WEA control LLM (WEA_*), NOT the worker pi default model.
 * Writes a challenger under library/templates/<id>@<ver>.json when --apply.
 *
 * Usage:
 *   WEA_BASE_URL=.. WEA_API_KEY=.. WEA_MODEL=.. \
 *     tsx src/meta-improve.ts --report <postmortem.json> --template t3-complex \
 *       [--out library/templates] [--apply]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_PLANE_IDENTITY } from "./control-identity.ts";
import { loadTemplate } from "./library.ts";
import {
	applyProposal,
	gateProposal,
	type Proposal,
	type RunnerTemplateDoc,
} from "./template-edit.ts";
import { controlComplete, parseJsonObject, requireWeaControlConfig } from "./wea-control.ts";

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

const META_SYSTEM = `${CONTROL_PLANE_IDENTITY}
You are the **meta-improvement** node of a self-evolving coding-agent system.
You redesign workflow templates (process), not application code. Workers that later
execute the graph use the user's default pi model — do NOT set per-node model fields.
Prefer evolutions that keep hard planning on control/handoff and mechanical work on workers.

OUTPUT: exactly one JSON object (wea.proposal/v2), no markdown:

{
  "schema": "wea.proposal/v2",
  "target_template": "<template id>",
  "target_version": "<template version>",
  "edits": [ /* remove_node | add_node | edit_prompt | set_model | add_edge | remove_edge | set_loop | remove_loop */ ],
  "reasoning": "<why>",
  "hypothesis": "<what A/B will test>",
  "expected_effect": "<predicted delta>"
}

Agent cards: inspector, explorer, aggregator, implementer, verifier.
Empty edits only if the current template is already best.`;

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const control = requireWeaControlConfig();

	const report = JSON.parse(readFileSync(args.report, "utf8"));
	const { graph, templateVersion } = loadTemplate(args.template);
	const templateDoc: RunnerTemplateDoc = {
		id: args.template.split("@", 1)[0]!,
		version: templateVersion,
		summary: report.template ?? args.template,
		graph,
	};

	const user = [
		"## Postmortem report",
		JSON.stringify(report, null, 2),
		"",
		"## Current template graph",
		JSON.stringify({ id: templateDoc.id, version: templateDoc.version, graph: templateDoc.graph }, null, 2),
		"",
		"Redesign this template. Emit wea.proposal/v2 JSON only.",
	].join("\n");

	console.log(`[meta] control model ${control.modelId} redesigning ${templateDoc.id} v${templateVersion}...`);
	const completion = await controlComplete(control, {
		system: META_SYSTEM,
		user,
		maxTokens: 4096,
		temperature: 0.3,
	});
	console.log(`[meta] control tokens in=${completion.usage.inputTokens} out=${completion.usage.outputTokens}`);

	const parsed = parseJsonObject(completion.text);
	if (!parsed) {
		console.error("[meta] unparseable proposal");
		console.error(completion.text.slice(0, 500));
		process.exit(1);
	}

	const proposal = parsed as unknown as Proposal;
	if (!proposal.schema) (proposal as any).schema = "wea.proposal/v2";
	if (!proposal.target_template) proposal.target_template = templateDoc.id;
	if (!proposal.target_version) proposal.target_version = templateDoc.version;
	if (!Array.isArray(proposal.edits)) proposal.edits = [];

	console.log("\n=== PROPOSAL ===");
	console.log(JSON.stringify(proposal, null, 2));

	const gate = gateProposal(templateDoc, proposal);
	console.log("\n=== GATE (structural executability only) ===");
	if (gate.ok) {
		console.log("RUNNABLE — quality decided later by champion A/B.");
	} else {
		console.log("NOT RUNNABLE:");
		for (const v of gate.violations) console.log("  · " + v);
	}

	if (gate.ok && proposal.edits.length > 0 && args.apply) {
		const next = applyProposal(templateDoc, proposal);
		for (const n of next.graph.nodes) delete n.model;
		const outPath = join(args.out, `${next.id}@${next.version}.json`);
		writeFileSync(outPath, JSON.stringify(next, null, 2) + "\n");
		console.log(`\n[meta] challenger written → ${outPath} (v${next.version})`);
	} else if (gate.ok && proposal.edits.length === 0) {
		console.log("\n[meta] proposal is 'no change' — nothing to apply.");
	} else if (!args.apply && gate.ok) {
		console.log("\n[meta] gate passed; re-run with --apply to write the new version.");
	}
}

main().catch((err) => {
	console.error("META-IMPROVE FAILED:", err);
	process.exit(1);
});
