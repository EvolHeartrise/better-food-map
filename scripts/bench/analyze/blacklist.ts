/**
 * Blacklist status for indexed runs — the read-only half of `bench:blacklist`.
 *
 * `bench:run` consults the blacklist to refuse SPENDING on a configuration
 * already ruled out. This module answers the other question, the one a reader of
 * the corpus has: is the row I am looking at a configuration we have retired?
 *
 * That matters most exactly where it is easiest to miss. A blacklisted cell can
 * sit on the Pareto frontier — `openai/gpt-5.6-terra --effort max` is the only
 * config in the corpus pairing 96.5% tag recall with 100% tag precision, and it
 * is blacklisted on cost — so a frontier read without this marker recommends a
 * configuration the project has already decided not to buy.
 *
 * A blacklist entry does NOT invalidate the runs it covers. Those runs are the
 * evidence the verdict was made from, and they stay in every average. The marker
 * says "we will not buy more of this", never "this data is bad" — which is why
 * nothing here filters, drops, or de-weights a run.
 *
 * All matching goes through `entryCovers`/`findBlock` in `../blacklist`, so the
 * scope rules (`*` covers every level, `default` covers only runs that passed no
 * `--effort`, an omitted backend covers both) are decided in exactly one place.
 */
import {
	EFFORT_ANY,
	EFFORT_DEFAULT,
	BLACKLIST_PATH,
	describeEntry,
	entryCovers,
	findBlock,
	loadBlacklist,
	type Blacklist,
	type BlacklistEntry,
	type RunConfig
} from '../blacklist';
import { dimensionValue } from './aggregate';
import type { RunRecord } from './record';

export { BLACKLIST_PATH };
export type { Blacklist, BlacklistEntry };

/** A blacklist entry as the viewer API sends it: every field a reader needs. */
export interface BlacklistInfo {
	model: string;
	/** The scope: `all`, `default` (no `--effort` passed), or a level name. */
	effort: string;
	/** Null covers both backends. */
	backend: string | null;
	/** Why the configuration was ruled out. Never empty — the CLI requires it. */
	reason: string;
	/** `YYYY-MM-DD`. An old verdict against a since-updated model reads as stale. */
	added: string;
	evidence: string | null;
	/** `model [effort: none]` — the CLI's own phrasing, so UI and stderr agree. */
	label: string;
	/**
	 * Runs in the corpus this entry currently covers, when the caller passed a
	 * corpus to count against; null when it did not — UNKNOWN, never 0.
	 *
	 * Zero is a real and DIFFERENT answer: a live verdict that hides nothing today
	 * because the model was never run, or was run only at other effort levels. It
	 * still blocks a future `bench:run`.
	 */
	n_runs_covered: number | null;
}

/**
 * How much of a group is covered.
 *
 * `partial` is a real state, not a rounding of `all`: the default cell grouping
 * splits on effort, so a cell is normally all-or-nothing, but `?dims=model`
 * merges every level of one model into a single row — and there, "some of these
 * runs are retired" is the honest answer. Collapsing it either way would either
 * retire live configurations or hide retired ones.
 */
export type BlacklistState = 'none' | 'partial' | 'all';

export interface BlacklistStatus {
	state: BlacklistState;
	/** Runs in the group covered by some entry. */
	n_blocked: number;
	/** Runs in the group. `n_blocked === n_runs > 0` is what makes the state `all`. */
	n_runs: number;
	/** The distinct entries doing the blocking, in blacklist-file order. */
	entries: BlacklistInfo[];
}

export const NO_BLACKLIST: BlacklistStatus = {
	state: 'none',
	n_blocked: 0,
	n_runs: 0,
	entries: []
};

/**
 * @param runs corpus to count coverage against. Omit when there is none to hand
 * and `n_runs_covered` becomes null (unknown) rather than a fabricated 0.
 */
export function toInfo(entry: BlacklistEntry, runs?: readonly RunRecord[]): BlacklistInfo {
	return {
		model: entry.model,
		effort: entry.effort === undefined || entry.effort === EFFORT_ANY ? 'all' : entry.effort,
		backend: entry.backend ?? null,
		reason: entry.reason,
		added: entry.added,
		evidence: entry.evidence ?? null,
		label: describeEntry(entry),
		n_runs_covered: runs === undefined ? null : runsCoveredBy(runs, entry)
	};
}

/** How many runs one entry covers — per ENTRY, not per model. */
export function runsCoveredBy(runs: readonly RunRecord[], entry: BlacklistEntry): number {
	return runs.filter((run) => entryCovers(entry, runConfig(run))).length;
}

/**
 * What a proposed scope would actually retire, BEFORE it is recorded.
 *
 * The blacklist has no provenance or quantization axis — its scope is
 * (model, effort, backend) — but the leaderboard splits cells on provenance and
 * quantization by design, because "aggregating a run served at fp4 with one
 * served at fp8 measures neither endpoint". So the button on a single row can
 * retire SEVERAL rows: `deepseek-v4-flash-0731 · openrouter · high` is two rows
 * in the current corpus (pinned fp8, and unpinned), and one verdict covers both.
 *
 * That is the blacklist working as specified — a verdict is about a model and a
 * reasoning level, not about an endpoint — but a UI that hides it lets someone
 * retire twice what they were looking at and file evidence describing half of
 * it. This is what the form shows so the scope is chosen with open eyes.
 */
export interface ScopeCoverage {
	n_runs: number;
	/** Distinct leaderboard rows (model × backend × effort × quantization × provenance). */
	n_configs: number;
	/** Config labels covered, sorted — so the form can name them when >1. */
	configs: string[];
	tasks: string[];
}

export function scopeCoverage(
	runs: readonly RunRecord[],
	scope: { model: string; effort?: string; backend?: string }
): ScopeCoverage {
	// A probe entry: `reason`/`added` are irrelevant to `entryCovers`, which reads
	// only model, effort and backend.
	const probe: BlacklistEntry = { ...scope, reason: '', added: '1970-01-01' };
	const covered = runs.filter((run) => entryCovers(probe, runConfig(run)));
	const configs = new Set<string>();
	for (const run of covered) {
		configs.add(
			[
				dimensionValue(run, 'backend'),
				dimensionValue(run, 'effort'),
				dimensionValue(run, 'quantization'),
				dimensionValue(run, 'provenance')
			].join(' · ')
		);
	}
	return {
		n_runs: covered.length,
		n_configs: configs.size,
		configs: [...configs].toSorted(),
		tasks: [...new Set(covered.map((run) => run.task))].toSorted()
	};
}

/**
 * A run as the blacklist sees it.
 *
 * `effort: null` on a record means no `--effort` was passed, which the blacklist
 * spells `undefined` — the distinction the `default` scope turns on, so it must
 * survive the hop from `meta.json` to the matcher.
 */
export function runConfig(run: RunRecord): RunConfig {
	return {
		model: run.model,
		effort: run.effort ?? undefined,
		backend: run.backend
	};
}

/** The entry retiring this run's configuration, or null. */
export function blockFor(run: RunRecord, list: Blacklist): BlacklistEntry | null {
	return findBlock(list, runConfig(run)) ?? null;
}

/**
 * Drop runs whose configuration is retired.
 *
 * Hiding is a VIEW choice, never a data one: the runs stay on disk, their
 * `report.json` is untouched, and `/api/overview` keeps counting them off this
 * filter so the number hidden is always on screen. A dashboard that quietly
 * drops rows is how "we tested everything" gets said about a slice.
 */
export function hideBlacklisted(runs: readonly RunRecord[], list: Blacklist): RunRecord[] {
	if (list.entries.length === 0) return [...runs];
	return runs.filter((run) => blockFor(run, list) === null);
}

/** Aggregate status over a group of runs — a cell, a model, the whole corpus. */
export function statusFor(runs: readonly RunRecord[], list: Blacklist): BlacklistStatus {
	// A Set of the entry OBJECTS: `findBlock` returns members of `list.entries`,
	// so identity dedupes without needing a synthetic key, and iteration order
	// follows insertion, which follows the file.
	const hits = new Set<BlacklistEntry>();
	let blocked = 0;
	for (const run of runs) {
		const entry = blockFor(run, list);
		if (entry === null) continue;
		blocked += 1;
		hits.add(entry);
	}
	const state: BlacklistState =
		blocked === 0 ? 'none' : blocked === runs.length ? 'all' : 'partial';
	return {
		state,
		n_blocked: blocked,
		n_runs: runs.length,
		entries: [...hits].map((entry) => toInfo(entry))
	};
}

/**
 * Per-model status across the corpus, for marking the model filter chips.
 *
 * Keyed by the model id as the runs spell it, and present ONLY for models with
 * at least one blocked run — a model with runs but no verdict against it is
 * absent, exactly like a model with no runs at all.
 *
 * That makes this map answer "is this chip retired", and nothing else. It is NOT
 * a corpus membership test: an absent key does not mean "this model has no
 * runs". Use `runsCoveredBy` when the question is about an entry's reach.
 */
export function modelStates(
	runs: readonly RunRecord[],
	list: Blacklist
): Record<string, BlacklistState> {
	const byModel = new Map<string, RunRecord[]>();
	for (const run of runs) {
		const group = byModel.get(run.model) ?? [];
		group.push(run);
		byModel.set(run.model, group);
	}
	const out: Record<string, BlacklistState> = {};
	for (const [model, group] of byModel) {
		const state = statusFor(group, list).state;
		if (state !== 'none') out[model] = state;
	}
	return out;
}

/**
 * Read the blacklist without letting a bad file take the dashboard down.
 *
 * `loadBlacklist` throws on a malformed file on purpose: for `bench:run`,
 * silently reading a corrupt blacklist as empty would re-enable the spending it
 * exists to prevent. A read-only viewer has no spending to protect, but it must
 * not answer "nothing is blacklisted" either — so the error is CARRIED, and the
 * UI reports the blacklist as unreadable rather than as empty.
 */
export function loadBlacklistSafe(path: string = BLACKLIST_PATH): {
	list: Blacklist;
	error: string | null;
} {
	try {
		return { list: loadBlacklist(path), error: null };
	} catch (error) {
		return {
			list: { entries: [] },
			error: error instanceof Error ? error.message : String(error)
		};
	}
}

/** Re-exported so callers need not reach past this module for the scope sentinels. */
export { EFFORT_ANY, EFFORT_DEFAULT };
