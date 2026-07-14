/**
 * Rebuild both trace surfaces from a saved run manifest — lets the exporter
 * iterate without re-spending LLM calls.
 *
 * Usage: tsx src/rebuild.ts runs/<name>.manifest.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { buildComplianceTrace, buildPvfTrace, type RunManifest } from "./trace-export.ts";

const manifestPath = process.argv[2];
if (!manifestPath) {
	console.error("usage: tsx src/rebuild.ts <manifest.json>");
	process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest;
const base = manifestPath.replace(/\.manifest\.json$/, "");
writeFileSync(`${base}.trace.json`, JSON.stringify(buildComplianceTrace(manifest), null, 2));
writeFileSync(`${base}.pvf.json`, JSON.stringify(buildPvfTrace(manifest), null, 2));
console.log(`${base}.trace.json`);
console.log(`${base}.pvf.json`);
