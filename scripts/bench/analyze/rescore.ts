/**
 * Rescore-on-read: compare a run's frozen report against CURRENT gold.
 *
 * `bench:run` scores once and writes `report.json`, so a run's numbers are a
 * snapshot of the gold as it stood that day. Gold moves — three
 * `policy_version`s are already in play across the existing corpus, and the
 * bench's history is full of gold corrections (tag fixes, the variant-naming
 * convention, the happy-hour rule). Every one of those silently invalidated the
 * reports written before it, with nothing on disk to say so.
 *
 * Since `candidate.json` preserves exactly what the model submitted, and
 * `scoreCandidate` is a pure, tested function, the fix is to re-run the scorer
 * on demand. Both numbers are then shown: `as_scored` (what the run reported,
 * the historical record) and `current` (what the same submission scores against
 * today's gold, the comparable number).
 *
 * This module never writes. Rescoring is a lens, not a migration — rewriting
 * report.json would destroy the historical record it exists to preserve.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { GoldSchema, type GoldMenu } from '../lint';
import { CandidateSchema, scoreCandidate, type ScoreReport } from '../score';
import { loadCandidate, type RunRecord } from './record';

export const DEFAULT_TASKS_DIR = 'bench/tasks';

/** Resolve a run's task directory: meta's own pointer first, conventional path second. */
export function taskDirFor(run: RunRecord, tasksDir: string = DEFAULT_TASKS_DIR): string {
	if (run.task_dir && existsSync(run.task_dir)) return run.task_dir;
	return join(tasksDir, run.task);
}

const goldCache = new Map<string, { gold: GoldMenu | null; error?: string }>();

/**
 * Load and validate a task's current gold, memoized per path.
 *
 * Memoized because rescoring a leaderboard touches the same four golds hundreds
 * of times; call `clearGoldCache()` after editing gold (the viewer does this on
 * its file watch) so a promote from `bench:review` shows up immediately.
 */
export function loadGold(taskDir: string): { gold: GoldMenu | null; error?: string } {
	const cached = goldCache.get(taskDir);
	if (cached) return cached;

	let result: { gold: GoldMenu | null; error?: string };
	try {
		const raw: unknown = JSON.parse(readFileSync(join(taskDir, 'gold', 'data.json'), 'utf-8'));
		result = { gold: v.parse(GoldSchema, raw) };
	} catch (error) {
		result = {
			gold: null,
			error: error instanceof Error ? error.message : String(error)
		};
	}
	goldCache.set(taskDir, result);
	return result;
}

export function clearGoldCache(): void {
	goldCache.clear();
}

export interface RescoreResult {
	run_id: string;
	/** The report written at run time. Null on a failed run. */
	as_scored: ScoreReport | null;
	/** The same submission scored against gold as it stands now. Null when unavailable. */
	current: ScoreReport | null;
	/** Gold's policy_version at run time, as recorded on the run. */
	run_policy_version: string | null;
	/** Gold's policy_version now. */
	current_policy_version: string | null;
	/**
	 * True when the two reports disagree on any aggregate metric — i.e. the
	 * frozen report no longer describes this submission. A policy_version bump
	 * alone does NOT set this; only a numeric difference does, because an
	 * editorial gold change that moved no score is not staleness that matters.
	 */
	changed: boolean;
	error?: string;
}

/** Aggregate fields compared to decide whether a rescore actually moved anything. */
const COMPARED_FIELDS = [
	'item_recall',
	'item_precision',
	'tag_precision',
	'tag_recall',
	'optional_tag_precision',
	'optional_tag_recall',
	'price_accuracy',
	'description_accuracy',
	'warning_accuracy',
	'source_recall',
	'source_precision',
	'gold_items',
	'candidate_items',
	'matched'
] as const;

export function reportsDiffer(a: ScoreReport, b: ScoreReport): boolean {
	return COMPARED_FIELDS.some((field) => a[field] !== b[field]);
}

/**
 * Rescore one run against current gold. Never throws: a missing candidate,
 * absent gold, or a candidate that no longer validates all degrade to
 * `current: null` with an `error`, because a single unreadable task must not
 * take down a leaderboard.
 */
export function rescoreRun(run: RunRecord, tasksDir: string = DEFAULT_TASKS_DIR): RescoreResult {
	const base: RescoreResult = {
		run_id: run.run_id,
		as_scored: run.report,
		current: null,
		run_policy_version: run.policy_version,
		current_policy_version: null,
		changed: false
	};

	const { gold, error: goldError } = loadGold(taskDirFor(run, tasksDir));
	if (!gold) return { ...base, error: goldError ?? 'gold not found' };
	base.current_policy_version = gold.policy_version;

	const candidateRaw = loadCandidate(run.dir);
	if (candidateRaw === null) {
		// Expected on a failed run, which never submitted anything.
		return {
			...base,
			error: run.status === 'failed' ? 'run failed; no candidate' : 'no candidate.json'
		};
	}

	try {
		const candidate = v.parse(CandidateSchema, candidateRaw);
		const current = scoreCandidate(gold, candidate);
		return {
			...base,
			current,
			changed: base.as_scored ? reportsDiffer(base.as_scored, current) : false
		};
	} catch (error) {
		return { ...base, error: error instanceof Error ? error.message : String(error) };
	}
}
