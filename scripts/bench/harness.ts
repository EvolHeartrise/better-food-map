/**
 * Harness registry — the AGENT SETUP a bench run was driven by.
 *
 * `--model`/`--effort`/`--quantization` describe WHO answered. A harness
 * describes HOW they were asked: one shot, a draft-then-correct pair, or (later)
 * a planner/executor split or an ensemble vote. It is a configuration axis in
 * exactly the same sense as provider quantization — two runs that differ only in
 * harness are not repeats of one measurement, and merging them into one
 * leaderboard cell reports a number that describes neither setup.
 *
 * Adding a harness means adding an entry to `HARNESSES` and nothing else: the
 * runner iterates `passes`, the meta records the name and the per-pass prompt
 * hashes, and the analysis layer already splits cells on both.
 *
 * The invariant every harness must hold: NO pass may see gold, a score, a lint
 * result computed against gold, or anything else derived from the answer key. A
 * review pass gets the previous pass's own output and the same snapshot — that
 * is the whole point of measuring it. A harness that peeks measures nothing.
 */
import {
	REVIEW_PATCH_SYSTEM_PROMPT,
	REVIEW_SYSTEM_PROMPT,
	SYSTEM_PROMPT,
	buildExtractUserMessage,
	buildReviewUserMessage,
	promptSha
} from './prompts';
import type { CandidateMenu } from './score';
// Type-only: erased at build, so this never forms a runtime cycle with run.ts
// (which imports this module's values).
import type { RunResult } from './run';

/** What a pass is for. `extract` reads the site; `review` corrects a draft. */
export type PassRole = 'extract' | 'review';

export interface PassSpec {
	/** 1-based position in the harness. */
	index: number;
	role: PassRole;
	/** The system prompt this pass runs under. */
	systemPrompt: string;
	/**
	 * How this pass submits. `menu` (the default) is a full submit_menu
	 * re-emission; `patch` replaces it with submit_corrections — operations
	 * applied to the previous pass's candidate — so a reviewer of a 180-item
	 * menu spends its output tokens on its corrections, not on re-typing the
	 * 160 items it never doubted. Only meaningful on a pass with a previous
	 * candidate to patch.
	 */
	submission?: 'menu' | 'patch';
}

export interface HarnessSpec {
	name: string;
	/** One line, shown in `--help` and the viewer. */
	description: string;
	passes: readonly PassSpec[];
}

export const HARNESSES: Record<string, HarnessSpec> = {
	'single-pass': {
		name: 'single-pass',
		description: 'One agent extracts the menu and submits. The original bench loop.',
		passes: [{ index: 1, role: 'extract', systemPrompt: SYSTEM_PROMPT }]
	},
	'two-pass': {
		name: 'two-pass',
		description:
			'One agent extracts; a second fresh agent is handed that submission plus the same snapshot and told to correct it. Scored on the second submission.',
		passes: [
			{ index: 1, role: 'extract', systemPrompt: SYSTEM_PROMPT },
			{ index: 2, role: 'review', systemPrompt: REVIEW_SYSTEM_PROMPT }
		]
	},
	'two-pass-patch': {
		name: 'two-pass-patch',
		description:
			'Two-pass where the reviewer submits corrections (add/remove/update ops applied to the draft) instead of re-emitting the whole menu. Scored on the patched result.',
		passes: [
			{ index: 1, role: 'extract', systemPrompt: SYSTEM_PROMPT },
			{ index: 2, role: 'review', systemPrompt: REVIEW_PATCH_SYSTEM_PROMPT, submission: 'patch' }
		]
	}
};

/** The default when `--harness` is absent — today's behaviour, unchanged. */
export const DEFAULT_HARNESS = 'single-pass';

export const HARNESS_NAMES: string[] = Object.keys(HARNESSES);

export function isHarnessName(name: string): boolean {
	return Object.prototype.hasOwnProperty.call(HARNESSES, name);
}

export function harnessFor(name: string): HarnessSpec | undefined {
	// Guarded, not a raw index: `harnessFor('constructor')` would otherwise return
	// `Object.prototype.constructor` and be treated as a harness spec.
	return isHarnessName(name) ? HARNESSES[name] : undefined;
}

/**
 * The user message that opens `pass`. An extract pass gets the entry URL; a
 * review pass gets the entry URL plus the previous pass's submission.
 *
 * A review pass with no previous candidate is a programming error, not a
 * runtime condition — the runner stops the harness when a pass fails to submit,
 * so a later pass is never reached without one.
 */
export function userMessageFor(
	pass: PassSpec,
	entryUrl: string,
	previous: CandidateMenu | undefined
): string {
	if (pass.role === 'review') {
		if (!previous) {
			throw new Error(`pass ${pass.index} (review) has no previous candidate to review`);
		}
		return buildReviewUserMessage(entryUrl, previous, pass.submission ?? 'menu');
	}
	return buildExtractUserMessage(entryUrl);
}

/**
 * Per-pass prompt hashes, keyed by `<index>-<role>` (e.g. `1-extract`).
 *
 * Keyed by index as well as role because a harness may legitimately run the
 * same role twice with different prompts, and a role-only key would silently
 * collapse them to one hash — hiding exactly the drift this exists to expose.
 */
export function promptShasFor(harness: HarnessSpec): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pass of harness.passes) {
		out[`${pass.index}-${pass.role}`] = promptSha(pass.systemPrompt);
	}
	return out;
}

/**
 * The full prompt text behind each hash, keyed like `promptShasFor`.
 *
 * `meta.json` records only the sha; resolving a sha back to the text it names
 * meant walking git history for the right revision of `prompts.ts`. Written to
 * each run directory as `prompts.json`, so a run is self-describing: the exact
 * prompt that produced it travels with it.
 */
export function promptTextsFor(
	harness: HarnessSpec
): Record<string, { sha: string; text: string }> {
	const out: Record<string, { sha: string; text: string }> = {};
	for (const pass of harness.passes) {
		out[`${pass.index}-${pass.role}`] = {
			sha: promptSha(pass.systemPrompt),
			text: pass.systemPrompt
		};
	}
	return out;
}

/**
 * A short, stable label for a whole prompt set, for use as a leaderboard
 * dimension value. Passes joined in index order, e.g. `a3f1c8/7d2e94`.
 *
 * `null` in means the run predates prompt hashing, which is NOT "no prompt" —
 * it is an unknown prompt, and the label says so. Those runs must not pool with
 * runs whose prompt is known, even if the text happens to be identical, because
 * nothing recorded establishes that it was.
 */
export function promptShaLabel(shas: Record<string, string> | null | undefined): string {
	if (!shas) return 'unknown';
	// Ordered by pass INDEX, not lexicographically: keys are `<index>-<role>`, so
	// a 10-pass harness would otherwise put `10-x` before `2-y` and give the same
	// prompt set two different labels depending on pass count.
	const keys = Object.keys(shas).toSorted((a, b) => {
		const ai = Number.parseInt(a, 10);
		const bi = Number.parseInt(b, 10);
		if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
		return a.localeCompare(b);
	});
	if (keys.length === 0) return 'unknown';
	return keys.map((k) => shas[k]).join('/');
}

/**
 * The review-configuration label: `none` (the harness has no review pass),
 * `same` (the reviewer inherited the primary model and effort), or what it was
 * overridden to. Used as a leaderboard dimension, so a drafter/reviewer split
 * never pools with self-correction.
 *
 * Keyed off the HARNESS SPEC, never off which passes a run happened to complete.
 * Inferring it from `meta.passes` labelled a two-pass run whose first pass failed
 * as `none` — splitting its failures into a phantom cell and leaving the real
 * `two-pass · same` row reading a 0% failure rate. Worse, the mislabelling only
 * hit the INHERITED configuration, since an override still had `review_model` to
 * give it away, so failure rates were not even comparable between the two.
 *
 * One implementation for both the runner and the analysis layer, because two
 * implementations of one label is how a cell gets labelled two ways.
 */
export function reviewLabel(opts: {
	harness: string;
	reviewModel: string | null | undefined;
	reviewEffort: string | null | undefined;
}): string {
	const spec = harnessFor(opts.harness);
	// `null` and `undefined` both mean "not set": meta.json writes null, CliArgs
	// leaves it undefined, and this one function serves both callers.
	const reviewModel = opts.reviewModel ?? undefined;
	const reviewEffort = opts.reviewEffort ?? undefined;
	// An UNKNOWN harness is not assumed review-less: fall back to the overrides,
	// which are the only other evidence a review pass was configured.
	const hasReviewPass = spec
		? spec.passes.some((p) => p.role === 'review')
		: reviewModel !== undefined || reviewEffort !== undefined;
	if (!hasReviewPass) return 'none';
	if (reviewModel === undefined && reviewEffort === undefined) return 'same';
	const model = reviewModel ?? '(same model)';
	return reviewEffort === undefined ? model : `${model}@${reviewEffort}`;
}

// --- multi-pass accounting ----------------------------------------------------

/**
 * One pass's configuration and outcome, recorded on `meta.json`. The top-level
 * meta keeps carrying the run TOTALS (so every existing cost, token and timing
 * comparison stays valid for a multi-pass run); this is the breakdown.
 */
export interface PassMeta {
	index: number;
	role: PassRole;
	model: string;
	backend: string;
	effort: string | null;
	status: 'scored' | 'failed';
	failure_reason?: string;
	duration_ms: number;
	tool_calls: number;
	submit_attempts: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	cached_prompt_tokens: number;
	cache_write_tokens: number;
	/** Providers that served this pass, in first-seen order (openrouter only). */
	providers: string[];
	/** Real billed cost of this pass (openrouter only), when the provider reported it. */
	price?: number | null;
	/**
	 * Perfect-prefix-cache counterfactual for THIS pass, priced with THIS pass's
	 * model. Per-pass because rates differ across a `--review-model` split, and
	 * because the estimator's append-only prompt premise only holds inside one
	 * pass — a fresh message list under a different system prompt breaks it.
	 */
	price_cached?: number | null;
}

/**
 * Fold a sequence of per-pass results into the single `RunResult` the rest of
 * the pipeline expects.
 *
 * Every count is SUMMED across passes, because the question a two-pass row has
 * to answer on the Frontier is "what did this setup cost", not "what did its
 * last stage cost". Under-reporting there would make a two-pass config look
 * cheaper than the single-pass config it is built from, which is the one
 * comparison the whole axis exists to support.
 *
 * The surviving `candidate` is the LAST pass that produced one — the final
 * answer. `status` is `scored` iff that candidate exists; a harness whose first
 * pass submitted and whose second pass crashed is still a failed run, since the
 * setup being measured is the pair, not the better half of it.
 */
export function mergePassResults(results: readonly RunResult[]): RunResult {
	if (results.length === 0) {
		throw new Error('mergePassResults: no passes to merge');
	}
	// The LAST pass that produced a candidate — matching this function's contract
	// rather than relying on `runPasses` stopping at the first pass that did not.
	// A future harness that continues past a barren pass must not silently lose
	// the answer an earlier one produced.
	const last = results[results.length - 1];
	const lastWithCandidate = results.findLast((r) => r.candidate !== undefined);
	const providers: string[] = [];
	for (const r of results) {
		for (const p of r.providers ?? []) if (!providers.includes(p)) providers.push(p);
	}
	const costs = results
		.map((r) => r.totalCostUsd)
		.filter((c): c is number => typeof c === 'number');

	return {
		// `status`/`failureReason` come from the FINAL pass: the setup being measured
		// is the whole chain, so a chain whose last pass failed is a failed run even
		// if an earlier pass submitted.
		status: last.status,
		failureReason: last.failureReason,
		candidate: last.status === 'scored' ? lastWithCandidate?.candidate : undefined,
		toolCalls: sum(results, (r) => r.toolCalls),
		submitAttempts: sum(results, (r) => r.submitAttempts),
		promptTokens: sum(results, (r) => r.promptTokens),
		completionTokens: sum(results, (r) => r.completionTokens),
		totalTokens: sum(results, (r) => r.totalTokens),
		cachedPromptTokens: sum(results, (r) => r.cachedPromptTokens),
		cacheWriteTokens: sum(results, (r) => r.cacheWriteTokens),
		// Absent on every pass stays absent — 0 would claim a free run.
		totalCostUsd: costs.length === 0 ? undefined : costs.reduce((a, b) => a + b, 0),
		usages: results.flatMap((r) => r.usages ?? []),
		providers
	};
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
	return items.reduce((acc, item) => acc + pick(item), 0);
}
