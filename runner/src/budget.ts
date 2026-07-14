/**
 * Hard budget ledger — Phase 1 must-have (PI_INTEGRATION_PLAN §6: "并行节点烧钱失控"
 * 的对策是硬预算 + 超支 abort，不是可选项).
 *
 * The ledger tracks run-level totals; node sessions check `exceeded()` after every
 * usage sample and abort their AgentSession when the answer is yes. Totals are
 * also what trace-export writes into wea.trace/v1 `budget` — validate_ir.py
 * enforces sum(attempt costs) <= budget, so the ledger and the exporter must
 * agree on the same numbers.
 */

import type { RunBudget, UsageSample } from "./types.ts";

export interface BudgetSnapshot {
	tokensUsed: number;
	monetaryMicrounitsUsed: number;
	wallTimeMsUsed: number;
	tokensRemaining: number;
	monetaryRemaining: number;
	wallTimeRemaining: number;
}

export class BudgetLedger {
	private tokensUsed = 0;
	private microunitsUsed = 0;
	private readonly startedAtMs: number;

	constructor(readonly budget: RunBudget) {
		this.startedAtMs = Date.now();
	}

	/** Record one LLM call's usage. Returns true if the run is now over budget. */
	charge(usage: UsageSample): boolean {
		this.tokensUsed += usage.input + usage.output;
		this.microunitsUsed += usage.costMicrounits;
		return this.exceeded() !== null;
	}

	/** Which budget dimension is blown, or null if within budget. */
	exceeded(): "tokens" | "money" | "wall_time" | null {
		if (this.tokensUsed > this.budget.modelTokens) return "tokens";
		if (this.microunitsUsed > this.budget.monetaryMicrounits) return "money";
		if (Date.now() - this.startedAtMs > this.budget.wallTimeMs) return "wall_time";
		return null;
	}

	snapshot(): BudgetSnapshot {
		const wallUsed = Date.now() - this.startedAtMs;
		return {
			tokensUsed: this.tokensUsed,
			monetaryMicrounitsUsed: this.microunitsUsed,
			wallTimeMsUsed: wallUsed,
			tokensRemaining: Math.max(0, this.budget.modelTokens - this.tokensUsed),
			monetaryRemaining: Math.max(0, this.budget.monetaryMicrounits - this.microunitsUsed),
			wallTimeRemaining: Math.max(0, this.budget.wallTimeMs - wallUsed),
		};
	}
}

/** Convert a pi Usage (USD float cost) into our integer microunit sample. */
export function toUsageSample(usage: {
	input: number;
	output: number;
	cacheRead: number;
	totalTokens: number;
	cost?: { total?: number };
}): UsageSample {
	return {
		input: usage.input,
		output: usage.output,
		cachedInput: usage.cacheRead,
		total: usage.totalTokens,
		costMicrounits: Math.round((usage.cost?.total ?? 0) * 1_000_000),
	};
}
