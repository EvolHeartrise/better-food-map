/**
 * Per-run derived metrics.
 *
 * Everything here is a VIEW over a `RunRecord` — cheap arithmetic and
 * diagnostics that make runs comparable. Two rules hold throughout:
 *
 * 1. The scorer's numbers are canonical. Nothing in this module rewrites
 *    `item_recall` and friends; the name-fidelity split below is an OVERLAY that
 *    explains a miss, never a re-score of one.
 * 2. Unknown stays unknown. A derived value whose inputs are absent is `null`,
 *    never 0 — see the absent-vs-zero note in `record.ts`.
 */
import { nameMatchKey } from '../score';
import type { RunRecord } from './record';

/** How a run's cost figure was obtained — the two backends report differently. */
export type CostSource = 'openrouter-usage' | 'claude-sdk';

export interface DerivedRun {
	/** Real USD cost, whichever backend reported it. Null when neither did. */
	cost_usd: number | null;
	cost_source: CostSource | null;
	/**
	 * Share of prompt tokens served from a provider cache (0–1). Null when token
	 * counts are absent; note a real 0 (nothing cached) is meaningfully different
	 * and is reported as 0.
	 */
	cache_hit_rate: number | null;
	/** Completion tokens per second of agent-run wall-clock. */
	output_tok_per_s: number | null;
	/**
	 * `wall_clock_ms - duration_ms`: bench setup (manifest/gold load, the one-off
	 * models fetch), never model time. Null unless both durations were recorded.
	 */
	bench_overhead_ms: number | null;
	/**
	 * Count of dietary tags the candidate asserted that gold lacks. These are the
	 * free-of/safety claims the data policy treats as the dangerous failure, so
	 * they get promoted out of the report's list into a first-class number.
	 */
	unsafe_tag_claims: number | null;
	/** Whether OpenRouter re-routed mid-run — a run whose provenance is mixed. */
	rerouted: boolean;
	/**
	 * Provenance label for grouping and display: the providers that served the
	 * run with their quantization tiers, or an explicit unknown marker. Never
	 * silently blank — an unattributed score is not comparable to an attributed one.
	 */
	provenance: string;
}

export function deriveRun(run: RunRecord): DerivedRun {
	const cost = deriveCost(run);
	return {
		cost_usd: cost.value,
		cost_source: cost.source,
		cache_hit_rate:
			run.prompt_tokens === null || run.cached_prompt_tokens === null || run.prompt_tokens === 0
				? null
				: run.cached_prompt_tokens / run.prompt_tokens,
		output_tok_per_s:
			run.completion_tokens === null || run.duration_ms === null || run.duration_ms === 0
				? null
				: run.completion_tokens / (run.duration_ms / 1000),
		bench_overhead_ms:
			run.wall_clock_ms === null || run.duration_ms === null
				? null
				: run.wall_clock_ms - run.duration_ms,
		unsafe_tag_claims: run.report?.tag_false_positives?.length ?? null,
		rerouted: (run.providers?.length ?? 0) > 1,
		provenance: provenanceLabel(run)
	};
}

/**
 * The openrouter backend reports `price` (summed per-request usage), the claude
 * backend reports `total_cost_usd`. A run carries one or the other; `price:
 * null` on an openrouter run means no request surfaced a cost, which is unknown
 * rather than free.
 */
function deriveCost(run: RunRecord): { value: number | null; source: CostSource | null } {
	if (run.price !== null) return { value: run.price, source: 'openrouter-usage' };
	if (run.total_cost_usd !== null) return { value: run.total_cost_usd, source: 'claude-sdk' };
	return { value: null, source: null };
}

/**
 * Human/grouping label for who served a run and at what quantization.
 *
 * Deliberately verbose about ignorance. The bench README is explicit that a
 * score without this is unattributable — it measures model × provider ×
 * quantization, not the model — so an unknown provider must be visible as
 * `provider unknown`, and unpinned routing must read as "cheapest-first" rather
 * than as an absence of quantization.
 */
export function provenanceLabel(run: RunRecord): string {
	const pin =
		run.quantization_requested && run.quantization_requested.length > 0
			? `pinned:${run.quantization_requested.join('+')}`
			: 'unpinned';

	if (run.providers === null) return `provider unknown · ${pin}`;
	if (run.providers.length === 0) return `provider unreported · ${pin}`;

	const parts = run.providers.map((provider) => {
		const tier = run.provider_quantizations?.[provider];
		// An absent tier is a lookup gap, never evidence of no quantization.
		return tier ? `${provider}@${tier}` : `${provider}@?`;
	});
	return `${parts.join(' + ')} · ${pin}`;
}

// --- name-fidelity overlay ----------------------------------------------------

/**
 * A gold item the candidate missed, paired with the hallucinated candidate name
 * that most likely IS it under a different spelling.
 */
export interface RenamedItem {
	gold: string;
	candidate: string;
	/** Levenshtein distance between the two match keys. */
	distance: number;
	/** distance / length of the longer key — the similarity the threshold applies to. */
	ratio: number;
}

export interface NameFidelity {
	/** Misses explained by a rewritten name: the item WAS found, spelled differently. */
	renamed: RenamedItem[];
	/** Gold items with no plausible candidate counterpart — genuinely not extracted. */
	true_misses: string[];
	/** Candidate items that paired with nothing — genuinely invented. */
	true_hallucinations: string[];
}

/**
 * Pair distance threshold. 0.25 admits an apostrophe, a stray accent, a dropped
 * "&" or a one-word case/spacing slip on a typical menu-item name, while a
 * different dish (usually a different head noun) sits far above it. Diagnostics
 * only — no score depends on this constant.
 */
const RENAME_RATIO_THRESHOLD = 0.25;

/** Classic Levenshtein, iterative two-row. Menu names are short; this is ample. */
export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	let prev = Array.from({ length: b.length + 1 }, (_unused, i) => i);
	let curr: number[] = Array.from({ length: b.length + 1 }, () => 0);

	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length];
}

/** Digit runs in a key — `5 oz` vs `9 oz` are different items, not a typo. */
function digitSignature(key: string): string {
	return (key.match(/\d+/g) ?? []).join(',');
}

/**
 * Split a report's misses and hallucinations into "same item, rewritten name"
 * versus the real thing.
 *
 * The scorer matches names EXACTLY (by design — fuzzy matching would let a model
 * paraphrase its way to a good score), so a single dropped apostrophe costs one
 * miss AND one hallucination. Both failures are real, but they are different
 * problems: a rewritten name is a fidelity bug in the extraction, a true miss is
 * a coverage bug in the navigation. Reading them as one number hides which.
 *
 * Two guards keep the overlay from inventing renames, both from real corpus
 * cases where a naive edit-distance pairing lied:
 *
 * - **A duplicate submission is not a rename.** New York Fries gold carries both
 *   `Bacon Double Cheese` (a poutine) and `Bacon Double Cheese Dog`. A model that
 *   emitted `BACON DOUBLE CHEESE` twice had its second copy counted as a
 *   hallucination by the scorer; pairing it with the *Dog* made three genuinely
 *   un-extracted gold items disappear from `true_misses`. So a candidate whose
 *   key exactly matches ANY gold item on the menu can never be read as a rename
 *   of a different one, and vice versa.
 * - **Different numbers mean different items.** `… (5 oz)` and `… (9 oz glass)`
 *   sit 0.125 apart — well inside the threshold — but are separate menu items by
 *   the bench's own variant convention. Pairing requires an identical digit
 *   signature.
 *
 * Pairing is greedy over (ratio, distance, name) so it is deterministic, and
 * each OCCURRENCE is consumed at most once — tracked by index, not by name, so a
 * repeated name does not vanish from the residual buckets.
 *
 * `goldNames`/`candidateNames` are the FULL item lists when available; they are
 * what the duplicate guard consults. Passing only the unmatched lists still
 * works, it just weakens that guard.
 */
export function analyzeNameFidelity(
	missedItems: readonly string[],
	hallucinatedItems: readonly string[],
	context?: { goldNames?: readonly string[]; candidateNames?: readonly string[] }
): NameFidelity {
	const missKeys = missedItems.map((name) => ({ name, key: nameMatchKey(name) }));
	const hallKeys = hallucinatedItems.map((name) => ({ name, key: nameMatchKey(name) }));

	// Every key present on either side, so an exact duplicate of a DIFFERENT item
	// is recognizable as such rather than read as a rename.
	const goldKeys = new Set((context?.goldNames ?? missedItems).map((name) => nameMatchKey(name)));
	const candidateKeys = new Set(
		(context?.candidateNames ?? hallucinatedItems).map((name) => nameMatchKey(name))
	);

	interface Pairing extends RenamedItem {
		missIndex: number;
		hallIndex: number;
	}

	const pairings: Pairing[] = [];
	for (const [missIndex, miss] of missKeys.entries()) {
		for (const [hallIndex, hall] of hallKeys.entries()) {
			if (miss.key === hall.key) continue; // the scorer would have matched these
			// A name that exists verbatim elsewhere on either menu is a duplicate,
			// not a rewrite of this item.
			if (goldKeys.has(hall.key) || candidateKeys.has(miss.key)) continue;
			if (digitSignature(miss.key) !== digitSignature(hall.key)) continue;

			const distance = levenshtein(miss.key, hall.key);
			const longest = Math.max(miss.key.length, hall.key.length);
			const ratio = longest === 0 ? 0 : distance / longest;
			if (ratio > RENAME_RATIO_THRESHOLD) continue;
			pairings.push({
				gold: miss.name,
				candidate: hall.name,
				distance,
				ratio,
				missIndex,
				hallIndex
			});
		}
	}
	pairings.sort(
		(a, b) =>
			a.ratio - b.ratio ||
			a.distance - b.distance ||
			a.gold.localeCompare(b.gold) ||
			a.candidate.localeCompare(b.candidate) ||
			a.missIndex - b.missIndex ||
			a.hallIndex - b.hallIndex
	);

	// Indices, not names: a repeated hallucinated name has several occurrences and
	// pairing one must not consume the rest.
	const usedMiss = new Set<number>();
	const usedHall = new Set<number>();
	const renamed: RenamedItem[] = [];
	for (const pair of pairings) {
		if (usedMiss.has(pair.missIndex) || usedHall.has(pair.hallIndex)) continue;
		usedMiss.add(pair.missIndex);
		usedHall.add(pair.hallIndex);
		renamed.push({
			gold: pair.gold,
			candidate: pair.candidate,
			distance: pair.distance,
			ratio: pair.ratio
		});
	}

	return {
		renamed,
		true_misses: missedItems.filter((_name, index) => !usedMiss.has(index)),
		true_hallucinations: hallucinatedItems.filter((_name, index) => !usedHall.has(index))
	};
}

/**
 * Convenience: the fidelity overlay for a run, or null when it has no report.
 *
 * `goldNames`/`candidateNames` (the full item lists, which the viewer already
 * loads) sharpen the duplicate guard; omitting them still works.
 */
export function nameFidelityFor(
	run: RunRecord,
	context?: { goldNames?: readonly string[]; candidateNames?: readonly string[] }
): NameFidelity | null {
	if (!run.report) return null;
	const missed = Array.isArray(run.report.missed_items) ? run.report.missed_items : [];
	const hallucinated = Array.isArray(run.report.hallucinated_items)
		? run.report.hallucinated_items
		: [];
	return analyzeNameFidelity(missed, hallucinated, context);
}
