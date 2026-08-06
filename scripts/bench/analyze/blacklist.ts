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
	findBlock,
	loadBlacklist,
	type Blacklist,
	type BlacklistEntry,
	type RunConfig
} from '../blacklist';
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

export function toInfo(entry: BlacklistEntry): BlacklistInfo {
	return {
		model: entry.model,
		effort: entry.effort === undefined || entry.effort === EFFORT_ANY ? 'all' : entry.effort,
		backend: entry.backend ?? null,
		reason: entry.reason,
		added: entry.added,
		evidence: entry.evidence ?? null,
		label: describeEntry(entry)
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
 * Keyed by the model id as the runs spell it. A model appears here only when it
 * has runs — the facet lists are built from runs too, so a verdict against a
 * model nobody has run yet is reported through the entry list instead, where it
 * cannot be mistaken for a statement about data on screen.
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
