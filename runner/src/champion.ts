/**
 * Champion gate (L4, Phase 5 minimal) — pure TS, endpoint-independent judging.
 *
 * This is where safety actually lives under the trust model (D28): the
 * meta-agent may propose ANY redesign; a redesign becomes the default only by
 * WINNING a paired comparison against the current champion. This module owns the
 * judging + promotion + rollback decision, given the measured results of the two
 * arms. It does not itself run the endpoint — the caller collects paired run
 * metrics (from real runs or from ab_compare) and hands them here.
 *
 * Promotion rule (v0.2 §9.3, minimal form):
 *   A challenger is promoted iff, over the paired runs, ALL hold:
 *     (1) quality non-inferiority — challenger passes >= champion passes;
 *     (2) a real efficiency gain — challenger's median tokens OR cost is
 *         strictly lower by at least MIN_GAIN_FRAC;
 *     (3) no axis materially regresses — neither tokens nor cost is worse by
 *         more than MAX_REGRESS_FRAC. (This is what stops a noisy result — e.g.
 *         a JSON-retry that balloons tokens 60% but happens to be a bit cheaper —
 *         from being promoted; such a result is "inconclusive, run more pairs",
 *         not a win.)
 *   Otherwise the champion stands (rollback to it). The champion's release is
 *   never destroyed; promotion only moves an ALIAS.
 *
 * The alias is stored as library/templates/<family>.champion.json → { id }. The
 * runner can consult it to run "the current best <family>" without knowing the
 * version. Losing challengers stay on disk (immutable archive) but are not
 * aliased.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(HERE, "..", "..", "library", "templates");

/** One arm's measured outcome over N paired runs. */
export interface ArmResult {
	templateRef: string; // e.g. "t3-complex" or "t3-complex@1.0.1"
	tokens: number[]; // billed tokens per run
	dollars: number[]; // cost per run
	passes: boolean[]; // did each run pass its oracle?
}

export interface Verdict {
	promote: boolean;
	winner: string;
	reason: string;
	detail: {
		champion_pass: number;
		challenger_pass: number;
		champion_tokens_median: number;
		challenger_tokens_median: number;
		token_gain_frac: number;
		champion_cost_median: number;
		challenger_cost_median: number;
		cost_gain_frac: number;
		pairs: number;
	};
}

const MIN_GAIN_FRAC = 0.05; // require >=5% efficiency improvement on some axis.
const MAX_REGRESS_FRAC = 0.1; // reject if any axis is >10% worse (noise guard).

function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Judge a challenger against the champion from paired measurements.
 * Pure function — same inputs always yield the same verdict.
 */
export function judge(champion: ArmResult, challenger: ArmResult): Verdict {
	const champPass = champion.passes.filter(Boolean).length;
	const chalPass = challenger.passes.filter(Boolean).length;
	const champTok = median(champion.tokens);
	const chalTok = median(challenger.tokens);
	const champCost = median(champion.dollars);
	const chalCost = median(challenger.dollars);
	const tokenGain = champTok > 0 ? (champTok - chalTok) / champTok : 0;
	const costGain = champCost > 0 ? (champCost - chalCost) / champCost : 0;

	const detail = {
		champion_pass: champPass,
		challenger_pass: chalPass,
		champion_tokens_median: champTok,
		challenger_tokens_median: chalTok,
		token_gain_frac: tokenGain,
		champion_cost_median: champCost,
		challenger_cost_median: chalCost,
		cost_gain_frac: costGain,
		pairs: Math.min(champion.tokens.length, challenger.tokens.length),
	};

	// (1) non-inferiority on quality.
	if (chalPass < champPass) {
		return {
			promote: false,
			winner: champion.templateRef,
			reason: `challenger regressed quality (${chalPass} < ${champPass} passes); champion stands`,
			detail,
		};
	}
	// (3) no axis may materially regress — a big token blow-up is a real
	// regression even if the other axis happens to improve (noise guard).
	const worstRegress = Math.max(-tokenGain, -costGain); // positive = got worse
	if (worstRegress > MAX_REGRESS_FRAC) {
		return {
			promote: false,
			winner: champion.templateRef,
			reason:
				`inconclusive: an axis regressed ${(worstRegress * 100).toFixed(1)}% ` +
				`(tokens ${(tokenGain * 100).toFixed(1)}%, cost ${(costGain * 100).toFixed(1)}%) — ` +
				`run more pairs; champion stands`,
			detail,
		};
	}
	// (2) a real efficiency gain on at least one of tokens / cost.
	const gain = Math.max(tokenGain, costGain);
	if (gain >= MIN_GAIN_FRAC) {
		return {
			promote: true,
			winner: challenger.templateRef,
			reason:
				`challenger non-inferior (${chalPass} >= ${champPass} passes) and ` +
				`${(gain * 100).toFixed(1)}% cheaper (tokens ${(tokenGain * 100).toFixed(1)}%, cost ${(costGain * 100).toFixed(1)}%) — promote`,
			detail,
		};
	}
	return {
		promote: false,
		winner: champion.templateRef,
		reason: `no material efficiency gain (best ${(gain * 100).toFixed(1)}% < ${(MIN_GAIN_FRAC * 100).toFixed(0)}%); champion stands`,
		detail,
	};
}

// ---- alias store ------------------------------------------------------------

/** Family = base id before any @version (e.g. "t3-complex"). */
export function familyOf(ref: string): string {
	return ref.split("@", 1)[0]!;
}

function aliasPath(family: string, dir = TEMPLATES_DIR): string {
	return join(dir, `${family}.champion.json`);
}

/** Current champion ref for a family; defaults to the base id when unset. */
export function currentChampion(family: string, dir = TEMPLATES_DIR): string {
	const p = aliasPath(family, dir);
	if (!existsSync(p)) return family;
	return (JSON.parse(readFileSync(p, "utf8")) as { id: string }).id;
}

/** Move the champion alias. Never deletes any release; only re-points. */
export function promoteAlias(family: string, newRef: string, dir = TEMPLATES_DIR): void {
	writeFileSync(aliasPath(family, dir), JSON.stringify({ id: newRef, promoted_at: new Date().toISOString() }, null, 2));
}

/**
 * Full gate step: judge, and on a win move the alias; on a loss leave it.
 * Returns the verdict and the champion ref that is now authoritative.
 */
export function runChampionGate(
	champion: ArmResult,
	challenger: ArmResult,
	dir = TEMPLATES_DIR,
): { verdict: Verdict; championRef: string } {
	const verdict = judge(champion, challenger);
	const family = familyOf(champion.templateRef);
	if (verdict.promote) {
		promoteAlias(family, challenger.templateRef, dir);
		return { verdict, championRef: challenger.templateRef };
	}
	return { verdict, championRef: champion.templateRef };
}
