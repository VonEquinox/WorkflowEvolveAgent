/** Immutable workflow-template publication helpers. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunnerTemplateDoc } from "./template-edit.ts";

export function parseSemver(version: string): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) throw new Error(`invalid semantic version ${JSON.stringify(version)}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function bumpPatch(version: string): string {
	const [major, minor, patch] = parseSemver(version);
	return `${major}.${minor}.${patch + 1}`;
}

function writeExclusive(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

/** Publish a challenger without ever replacing an existing release. */
export function publishVersionedTemplate(
	doc: RunnerTemplateDoc,
	dir: string,
): { doc: RunnerTemplateDoc; path: string } {
	let version = doc.version;
	for (let attempt = 0; attempt < 10_000; attempt += 1) {
		const path = join(dir, `${doc.id}@${version}.json`);
		try {
			const published = { ...doc, version };
			writeExclusive(path, published);
			return { doc: published, path };
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			version = bumpPatch(version);
		}
	}
	throw new Error(`could not allocate a unique version for ${doc.id}`);
}

/** Publish a new base template, suffixing the id instead of overwriting. */
export function publishBaseTemplate(
	doc: RunnerTemplateDoc,
	dir: string,
): { doc: RunnerTemplateDoc; path: string } {
	for (let suffix = 1; suffix < 10_000; suffix += 1) {
		const id = suffix === 1 ? doc.id : `${doc.id}-${suffix}`;
		const path = join(dir, `${id}.json`);
		if (existsSync(path)) continue;
		try {
			const published = { ...doc, id };
			writeExclusive(path, published);
			return { doc: published, path };
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
		}
	}
	throw new Error(`could not allocate a unique base id for ${doc.id}`);
}
