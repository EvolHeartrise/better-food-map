/**
 * Model/config blacklist for bench runs.
 *
 * A record of (model, effort, backend) combinations that have been TESTED and
 * judged not worth testing again, so a growing bench never re-spends money on a
 * configuration already known to be inadequate. Entries are decisions, not
 * cache: each carries the reason it was ruled out and the date, so a future
 * reader can tell an obsolete verdict from a live one.
 *
 * The file lives beside this module (`scripts/bench/blacklist.json`) rather than
 * under `bench/` on purpose — `bench/` is gitignored, and these verdicts are
 * durable knowledge that must survive a machine change and be reviewable in a
 * diff.
 *
 * Usage:
 *   bun run bench:blacklist                      # list entries
 *   bun run bench:blacklist --add --model <id> [--effort <level>] [--backend <b>]
 *                           --reason <text> [--evidence <text>]
 *   bun run bench:blacklist --remove --model <id> [--effort <level>] [--backend <b>]
 *   bun run bench:blacklist --check --model <id> [--effort <level>] [--backend <b>]
 *
 * Exit 0 on success (and on --check when the config is ALLOWED), 1 on --check
 * when it is BLOCKED, 2 on a usage/validation error.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

/** `effort` sentinel: this entry covers every effort level, default included. */
export const EFFORT_ANY = '*';
/** `effort` sentinel: this entry covers ONLY runs that pass no --effort flag. */
export const EFFORT_DEFAULT = 'default';

/** Default blacklist path — beside this module, so it is git-tracked. */
export const BLACKLIST_PATH = join(import.meta.dir, 'blacklist.json');

export interface BlacklistEntry {
	/** Model id exactly as passed to --model (matched case-insensitively). */
	model: string;
	/**
	 * Which effort this verdict covers: a level name (`none`, `xhigh`, …),
	 * `'default'` for runs that pass no --effort, or `'*'`/omitted for all of them.
	 */
	effort?: string;
	/** `openrouter` | `claude`; omitted covers both. */
	backend?: string;
	/**
	 * Harness (agent setup) this verdict covers; omitted covers every harness.
	 *
	 * Omitted is the RIGHT default for a verdict about raw model capability ("it
	 * truncates long menus"), and the WRONG one for a verdict a different setup
	 * might overturn — a model ruled out for missing pages may well pass with a
	 * review pass that re-enumerates them. Scope the entry when the verdict is
	 * about the pairing rather than the model.
	 */
	harness?: string;
	/** Why this configuration was ruled out — required, this is the whole point. */
	reason: string;
	/** ISO date (YYYY-MM-DD) the verdict was recorded. */
	added: string;
	/** Optional pointer to the evidence (a run directory, a sweep summary). */
	evidence?: string;
}

export interface Blacklist {
	entries: BlacklistEntry[];
}

const EntrySchema = v.object({
	model: v.pipe(v.string(), v.minLength(1)),
	effort: v.optional(v.string()),
	backend: v.optional(v.string()),
	harness: v.optional(v.string()),
	reason: v.pipe(v.string(), v.minLength(1)),
	added: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/, 'added must be YYYY-MM-DD')),
	evidence: v.optional(v.string())
});

export const BlacklistSchema = v.object({ entries: v.array(EntrySchema) });

/** The configuration a run is about to use, as the blacklist sees it. */
export interface RunConfig {
	model: string;
	/** The requested level, or undefined when no --effort was passed. */
	effort?: string;
	backend: string;
	/** The harness the run would use; undefined is treated as the default setup. */
	harness?: string;
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Does `entry` cover `cfg`? Model, backend and harness must match (an entry
 * omitting backend or harness covers all of them); effort matches when the entry
 * is `*`/omitted, when the entry is `default` and the run passed no --effort, or
 * on an exact level match.
 */
export function entryCovers(entry: BlacklistEntry, cfg: RunConfig): boolean {
	if (norm(entry.model) !== norm(cfg.model)) return false;
	if (entry.backend !== undefined && norm(entry.backend) !== norm(cfg.backend)) return false;
	if (entry.harness !== undefined && norm(entry.harness) !== norm(cfg.harness ?? 'single-pass'))
		return false;

	const scope = entry.effort === undefined ? EFFORT_ANY : norm(entry.effort);
	if (scope === EFFORT_ANY) return true;
	if (scope === EFFORT_DEFAULT) return cfg.effort === undefined;
	return cfg.effort !== undefined && norm(cfg.effort) === scope;
}

/** The first entry blocking `cfg`, or undefined when the run may proceed. */
export function findBlock(list: Blacklist, cfg: RunConfig): BlacklistEntry | undefined {
	return list.entries.find((e) => entryCovers(e, cfg));
}

/**
 * Read the blacklist. A MISSING file is an empty blacklist (never an error — a
 * fresh checkout must run), but a malformed one throws: silently ignoring a
 * corrupt blacklist would re-enable spending the file exists to prevent.
 */
export function loadBlacklist(path: string = BLACKLIST_PATH): Blacklist {
	if (!existsSync(path)) return { entries: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf-8'));
	} catch (e) {
		throw new Error(`blacklist ${path} is not valid JSON: ${String(e)}`);
	}
	const parsed = v.safeParse(BlacklistSchema, raw);
	if (!parsed.success) {
		throw new Error(`blacklist ${path} is invalid: ${parsed.issues[0]?.message ?? 'unknown'}`);
	}
	return parsed.output;
}

/**
 * Write the blacklist ATOMICALLY: full contents to a sibling temp file, then
 * rename over the target.
 *
 * A plain `writeFileSync` truncates before it writes, so a crash — or a full
 * disk — mid-write leaves a half-file. `loadBlacklist` treats a malformed file
 * as a hard error, on purpose, so that window turns a crash into "every
 * bench:run refuses to start" plus the loss of every verdict in it. `rename` on
 * the same filesystem is atomic, so a reader sees either the old file or the new
 * one and never a partial.
 */
export function saveBlacklist(list: Blacklist, path: string = BLACKLIST_PATH): void {
	const temp = `${path}.tmp`;
	writeFileSync(temp, JSON.stringify(list, null, '\t') + '\n');
	try {
		renameSync(temp, path);
	} catch (error) {
		// Don't leave the temp file behind to be mistaken for a real one.
		try {
			unlinkSync(temp);
		} catch {
			// Best effort; the rename failure is the error worth reporting.
		}
		throw error;
	}
}

/** Human-readable scope of an entry, e.g. `openai/gpt-5.6-luna [effort: none]`. */
export function describeEntry(entry: BlacklistEntry): string {
	const scope = entry.effort === undefined || entry.effort === EFFORT_ANY ? 'all' : entry.effort;
	const backend = entry.backend === undefined ? '' : `, backend: ${entry.backend}`;
	// The harness scope is part of what a verdict covers, so it has to be part of
	// how the verdict READS. Without it a `harness: single-pass` entry and an
	// unscoped one printed identically in the CLI list, the refusal message and
	// the viewer's register — three places you would go to audit exactly that.
	const harness = entry.harness === undefined ? '' : `, harness: ${entry.harness}`;
	return `${entry.model} [effort: ${scope}${backend}${harness}]`;
}

/** The stderr message shown when a run is refused. */
export function formatBlocked(entry: BlacklistEntry, overrideFlag: string): string {
	return [
		`error: ${describeEntry(entry)} is blacklisted — skipping (no API spend).`,
		`  reason:   ${entry.reason}`,
		`  added:    ${entry.added}`,
		...(entry.evidence === undefined ? [] : [`  evidence: ${entry.evidence}`]),
		`  Re-test anyway with ${overrideFlag}, or drop the entry:`,
		`    bun run bench:blacklist --remove --model ${entry.model}` +
			(entry.effort === undefined ? '' : ` --effort ${entry.effort}`) +
			(entry.backend === undefined ? '' : ` --backend ${entry.backend}`) +
			(entry.harness === undefined ? '' : ` --harness ${entry.harness}`)
	].join('\n');
}

/**
 * Do two entries name the SAME scope? Every axis participates, including
 * `harness` — otherwise a `harness: two-pass` verdict could not be added beside
 * a `harness: single-pass` one ("already blacklisted"), and removing either took
 * both. Add and remove share this so they can never disagree about identity.
 */
function sameScopeAs(
	a: { model: string; effort?: string; backend?: string; harness?: string },
	b: { model: string; effort?: string; backend?: string; harness?: string }
): boolean {
	return (
		norm(a.model) === norm(b.model) &&
		norm(a.effort ?? EFFORT_ANY) === norm(b.effort ?? EFFORT_ANY) &&
		norm(a.backend ?? '') === norm(b.backend ?? '') &&
		norm(a.harness ?? '') === norm(b.harness ?? '')
	);
}

/**
 * Add an entry, refusing an exact duplicate scope (same model/effort/backend/
 * harness) so the file never accumulates competing verdicts for one configuration.
 */
export function addEntry(
	list: Blacklist,
	entry: BlacklistEntry
): { ok: true; list: Blacklist } | { ok: false; error: string } {
	const sameScope = list.entries.find((e) => sameScopeAs(e, entry));
	if (sameScope) {
		return { ok: false, error: `already blacklisted: ${describeEntry(sameScope)}` };
	}
	return { ok: true, list: { entries: [...list.entries, entry] } };
}

/** Remove every entry with exactly this scope; reports how many went. */
export function removeEntries(
	list: Blacklist,
	scope: { model: string; effort?: string; backend?: string; harness?: string }
): { list: Blacklist; removed: BlacklistEntry[] } {
	const removed = list.entries.filter((e) => sameScopeAs(e, scope));
	return {
		list: { entries: list.entries.filter((e) => !removed.includes(e)) },
		removed
	};
}

/** Render the whole blacklist for stderr. */
export function formatList(list: Blacklist): string {
	if (list.entries.length === 0) {
		return 'Blacklist is empty — every model/config is testable.';
	}
	const lines = [`Blacklisted configurations (${list.entries.length}):`];
	for (const e of list.entries) {
		lines.push(`  ${describeEntry(e)}`);
		lines.push(`      ${e.reason}  (added ${e.added})`);
		if (e.evidence !== undefined) lines.push(`      evidence: ${e.evidence}`);
	}
	return lines.join('\n');
}

// --- CLI ----------------------------------------------------------------------

const USAGE = [
	'usage:',
	'  bun run bench:blacklist',
	'  bun run bench:blacklist --add --model <id> [--effort <level|default|*>] [--backend <b>]',
	'                          [--harness <name>] --reason <text> [--evidence <text>]',
	'  bun run bench:blacklist --remove --model <id> [--effort <level>] [--backend <b>] [--harness <name>]',
	'  bun run bench:blacklist --check --model <id> [--effort <level>] [--backend <b>] [--harness <name>]'
].join('\n');

export interface BlacklistCli {
	mode: 'list' | 'add' | 'remove' | 'check';
	model?: string;
	effort?: string;
	backend?: string;
	/** Harness scope; omitted covers every harness. */
	harness?: string;
	reason?: string;
	evidence?: string;
}

/** The CLI flag that selects each mode — used to name the mode in errors. */
function modeFlag(mode: BlacklistCli['mode']): string {
	switch (mode) {
		case 'add':
			return '--add';
		case 'remove':
			return '--remove';
		case 'check':
			return '--check';
		default:
			return '--list';
	}
}

export function parseCli(argv: string[]): BlacklistCli | { error: string } {
	let mode: BlacklistCli['mode'] = 'list';
	let modeSet = false;
	const out: BlacklistCli = { mode };
	const setMode = (m: BlacklistCli['mode']): string | undefined => {
		if (modeSet) return 'pass exactly one of --add / --remove / --check';
		mode = m;
		modeSet = true;
		return undefined;
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--add' || arg === '--remove' || arg === '--check') {
			const err = setMode(arg.slice(2) as BlacklistCli['mode']);
			if (err) return { error: err };
		} else if (arg === '--list') {
			// The default mode; accepted explicitly for readability in scripts.
			if (modeSet) return { error: 'pass exactly one of --add / --remove / --check' };
		} else if (
			arg === '--model' ||
			arg === '--effort' ||
			arg === '--backend' ||
			arg === '--harness' ||
			arg === '--reason' ||
			arg === '--evidence'
		) {
			const value = argv[++i];
			if (value === undefined) return { error: `${arg} requires a value` };
			out[arg.slice(2) as 'model' | 'effort' | 'backend' | 'harness' | 'reason' | 'evidence'] =
				value;
		} else {
			return { error: `unknown option: ${arg}` };
		}
	}

	out.mode = mode;
	if (mode !== 'list') {
		if (out.model === undefined) return { error: `--model is required with ${modeFlag(mode)}` };
		if (mode === 'add' && out.reason === undefined) {
			return { error: '--reason is required with --add (a verdict without a reason is unusable)' };
		}
	}
	if (out.backend !== undefined && out.backend !== 'openrouter' && out.backend !== 'claude') {
		return { error: `--backend must be openrouter|claude (got ${out.backend})` };
	}
	return out;
}

/** YYYY-MM-DD in UTC. */
export function today(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

function main(): number {
	const cli = parseCli(process.argv.slice(2));
	if ('error' in cli) {
		console.error(`error: ${cli.error}`);
		console.error(USAGE);
		return 2;
	}

	let list: Blacklist;
	try {
		list = loadBlacklist();
	} catch (e) {
		console.error(`error: ${String(e)}`);
		return 2;
	}

	if (cli.mode === 'list') {
		console.error(formatList(list));
		return 0;
	}

	// Non-list modes all require --model, guaranteed by parseCli.
	const model = cli.model as string;

	if (cli.mode === 'check') {
		const hit = findBlock(list, {
			model,
			effort: cli.effort,
			backend: cli.backend ?? 'openrouter',
			harness: cli.harness
		});
		if (hit) {
			console.error(`BLOCKED: ${describeEntry(hit)} — ${hit.reason} (added ${hit.added})`);
			return 1;
		}
		console.error(
			`allowed: ${model} [effort: ${cli.effort ?? 'default'}, harness: ${cli.harness ?? 'single-pass'}]`
		);
		return 0;
	}

	if (cli.mode === 'add') {
		const result = addEntry(list, {
			model,
			effort: cli.effort,
			backend: cli.backend,
			harness: cli.harness,
			reason: cli.reason as string,
			added: today(),
			evidence: cli.evidence
		});
		if (!result.ok) {
			console.error(`error: ${result.error}`);
			return 2;
		}
		saveBlacklist(result.list);
		console.error(
			`blacklisted ${describeEntry(result.list.entries[result.list.entries.length - 1])}`
		);
		console.error(`${BLACKLIST_PATH} now holds ${result.list.entries.length} entr(y|ies)`);
		return 0;
	}

	const { list: next, removed } = removeEntries(list, {
		model,
		effort: cli.effort,
		backend: cli.backend,
		harness: cli.harness
	});
	if (removed.length === 0) {
		console.error(
			`error: no entry matching ${model} [effort: ${cli.effort ?? 'all'}` +
				`${cli.harness === undefined ? '' : `, harness: ${cli.harness}`}] — nothing removed`
		);
		console.error(formatList(list));
		return 2;
	}
	saveBlacklist(next);
	for (const e of removed) console.error(`removed ${describeEntry(e)}`);
	return 0;
}

if (import.meta.main) {
	process.exit(main());
}
