/**
 * Bench task scaffolder + strata status.
 *
 * Two modes:
 *   bun run bench:new <slug> <entry-url> --stratum <name>
 *       Scaffold bench/tasks/<slug>/ with a task.json and print the next-step
 *       commands. Does NOT crawl — run bench:record next.
 *   bun run bench:new --status
 *       Print the stratification matrix: which canonical strata are filled, and
 *       a per-task table of recorded / authored / draft-pending / item count.
 *   bun run bench:new --claim <slug> --stratum <name>
 *       Write a task.json for an EXISTING task dir that lacks one.
 *
 * Exit 0 on success (and on --status even when there is no bench data), 2 on a
 * usage/validation error or a refusal.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { GoldSchema } from './lint';
import { loadManifest } from './snapshot-store';

/** The canonical stratification of the menu-extraction bench. */
export const STRATA = [
	'single-page',
	'multi-page',
	'api-backed',
	'pdf-menu',
	'allergen-legend',
	'closed-venue',
	'bot-walled'
] as const;

export type Stratum = (typeof STRATA)[number];

const TASKS_ROOT = join('bench', 'tasks');
const UNSET = '(unset)';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface TaskJson {
	slug: string;
	entry_url: string;
	stratum: string;
	created_at: string;
}

const TaskJsonSchema = v.object({
	slug: v.string(),
	entry_url: v.string(),
	stratum: v.string(),
	created_at: v.string()
});

export function isValidSlug(slug: string): boolean {
	return SLUG_RE.test(slug);
}

export function isValidStratum(stratum: string): stratum is Stratum {
	return (STRATA as readonly string[]).includes(stratum);
}

export function isValidEntryUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === 'http:' || u.protocol === 'https:';
	} catch {
		return false;
	}
}

/** Read and validate a task's task.json; undefined when absent or malformed. */
function readTaskJson(taskDir: string): TaskJson | undefined {
	const path = join(taskDir, 'task.json');
	try {
		const parsed = v.safeParse(TaskJsonSchema, JSON.parse(readFileSync(path, 'utf-8')));
		return parsed.success ? parsed.output : undefined;
	} catch {
		return undefined;
	}
}

function writeTaskJson(taskDir: string, task: TaskJson): void {
	writeFileSync(join(taskDir, 'task.json'), JSON.stringify(task, null, '\t') + '\n');
}

export type MutationResult = { ok: true; taskDir: string } | { ok: false; error: string };

/** Validate + scaffold a brand-new task directory with a task.json. */
export function createTask(opts: {
	tasksRoot: string;
	slug: string;
	entryUrl: string;
	stratum: string;
}): MutationResult {
	if (!isValidSlug(opts.slug)) {
		return { ok: false, error: `invalid slug "${opts.slug}" — must be kebab-case (a-z, 0-9, -)` };
	}
	if (!isValidEntryUrl(opts.entryUrl)) {
		return { ok: false, error: `invalid entry URL "${opts.entryUrl}" — must be an http(s) URL` };
	}
	if (!isValidStratum(opts.stratum)) {
		return { ok: false, error: `unknown stratum "${opts.stratum}" — one of: ${STRATA.join(', ')}` };
	}
	const taskDir = join(opts.tasksRoot, opts.slug);
	if (existsSync(taskDir)) {
		return { ok: false, error: `task dir already exists: ${taskDir}` };
	}
	mkdirSync(taskDir, { recursive: true });
	writeTaskJson(taskDir, {
		slug: opts.slug,
		entry_url: opts.entryUrl,
		stratum: opts.stratum,
		created_at: new Date().toISOString()
	});
	return { ok: true, taskDir };
}

/** Write a task.json for an EXISTING task dir (e.g. a pre-tooling snapshot). */
export function claimTask(opts: {
	tasksRoot: string;
	slug: string;
	stratum: string;
}): MutationResult {
	if (!isValidSlug(opts.slug)) {
		return { ok: false, error: `invalid slug "${opts.slug}" — must be kebab-case (a-z, 0-9, -)` };
	}
	if (!isValidStratum(opts.stratum)) {
		return { ok: false, error: `unknown stratum "${opts.stratum}" — one of: ${STRATA.join(', ')}` };
	}
	const taskDir = join(opts.tasksRoot, opts.slug);
	if (!existsSync(taskDir)) {
		return { ok: false, error: `no such task dir: ${taskDir} — use create mode for a new task` };
	}
	const existing = readTaskJson(taskDir);
	const manifest = loadManifest(taskDir);
	writeTaskJson(taskDir, {
		slug: opts.slug,
		entry_url: existing?.entry_url ?? manifest?.entryUrl ?? '',
		stratum: opts.stratum,
		created_at: existing?.created_at ?? new Date().toISOString()
	});
	return { ok: true, taskDir };
}

// --- status matrix ------------------------------------------------------------

export interface TaskStatusRow {
	slug: string;
	stratum: string;
	recorded: boolean;
	authored: boolean;
	draftPending: boolean;
	itemCount: number | null;
}

export interface StatusMatrix {
	byStratum: { stratum: Stratum; slugs: string[] }[];
	rows: TaskStatusRow[];
}

/** Item count of an authored gold, or null when absent/invalid. */
function goldItemCount(taskDir: string): number | null {
	const path = join(taskDir, 'gold', 'data.json');
	if (!existsSync(path)) return null;
	try {
		const parsed = v.safeParse(GoldSchema, JSON.parse(readFileSync(path, 'utf-8')));
		return parsed.success ? parsed.output.items.length : null;
	} catch {
		return null;
	}
}

/** Assemble the status matrix from a tasks root (does not print). */
export function buildStatus(tasksRoot: string): StatusMatrix {
	const slugs = readdirSync(tasksRoot).filter((name) => {
		try {
			return statSync(join(tasksRoot, name)).isDirectory();
		} catch {
			return false;
		}
	});

	const rows: TaskStatusRow[] = slugs.map((slug) => {
		const taskDir = join(tasksRoot, slug);
		const task = readTaskJson(taskDir);
		return {
			slug,
			stratum: task?.stratum ?? UNSET,
			recorded: loadManifest(taskDir) !== undefined,
			authored: existsSync(join(taskDir, 'gold', 'data.json')),
			draftPending: existsSync(join(taskDir, 'gold', 'draft.json')),
			itemCount: goldItemCount(taskDir)
		};
	});
	rows.sort((a, b) => a.slug.localeCompare(b.slug));

	const byStratum = STRATA.map((stratum) => ({
		stratum,
		slugs: rows.filter((r) => r.stratum === stratum).map((r) => r.slug)
	}));

	return { byStratum, rows };
}

const check = (b: boolean): string => (b ? 'yes' : '-');

/** Render the status matrix for stderr. */
export function formatStatus(status: StatusMatrix): string {
	const lines = ['Strata coverage:'];
	for (const { stratum, slugs } of status.byStratum) {
		lines.push(`  ${stratum.padEnd(16)} ${slugs.length === 0 ? 'EMPTY' : slugs.join(', ')}`);
	}
	lines.push('');
	lines.push('Tasks:');
	const header = `  ${'slug'.padEnd(24)} ${'stratum'.padEnd(16)} ${'rec'.padEnd(4)} ${'gold'.padEnd(5)} ${'draft'.padEnd(6)} items`;
	lines.push(header);
	if (status.rows.length === 0) {
		lines.push('  (no tasks)');
	}
	for (const r of status.rows) {
		lines.push(
			`  ${r.slug.padEnd(24)} ${r.stratum.padEnd(16)} ${check(r.recorded).padEnd(4)} ` +
				`${check(r.authored).padEnd(5)} ${check(r.draftPending).padEnd(6)} ` +
				`${r.itemCount === null ? '-' : r.itemCount}`
		);
	}
	return lines.join('\n');
}

// --- CLI ----------------------------------------------------------------------

interface CreateArgs {
	mode: 'create';
	slug: string;
	entryUrl: string;
	stratum: string;
}
interface ClaimArgs {
	mode: 'claim';
	slug: string;
	stratum: string;
}
interface StatusArgs {
	mode: 'status';
}
type CliArgs = CreateArgs | ClaimArgs | StatusArgs;

function parseCli(argv: string[]): CliArgs | { error: string } {
	const positional: string[] = [];
	let stratum: string | undefined;
	let claimSlug: string | undefined;
	let status = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--status') {
			status = true;
		} else if (arg === '--stratum') {
			stratum = argv[++i];
			if (!stratum) return { error: '--stratum requires a value' };
		} else if (arg === '--claim') {
			claimSlug = argv[++i];
			if (!claimSlug) return { error: '--claim requires a <slug>' };
		} else if (arg.startsWith('--')) {
			return { error: `unknown option: ${arg}` };
		} else {
			positional.push(arg);
		}
	}

	if (status) {
		if (positional.length > 0 || stratum !== undefined || claimSlug !== undefined) {
			return { error: '--status takes no other arguments' };
		}
		return { mode: 'status' };
	}
	if (claimSlug !== undefined) {
		if (positional.length > 0) return { error: `unexpected argument: ${positional[0]}` };
		if (stratum === undefined) return { error: 'missing --stratum <name>' };
		return { mode: 'claim', slug: claimSlug, stratum };
	}
	if (stratum === undefined) return { error: 'missing --stratum <name>' };
	if (positional.length < 2) return { error: 'missing <slug> <entry-url>' };
	if (positional.length > 2) return { error: `unexpected argument: ${positional[2]}` };
	return { mode: 'create', slug: positional[0], entryUrl: positional[1], stratum };
}

const USAGE = [
	'usage:',
	'  bun run bench:new <slug> <entry-url> --stratum <name>',
	'  bun run bench:new --status',
	'  bun run bench:new --claim <slug> --stratum <name>',
	`  strata: ${STRATA.join(', ')}`
].join('\n');

function main(): number {
	const cli = parseCli(process.argv.slice(2));
	if ('error' in cli) {
		console.error(`error: ${cli.error}`);
		console.error(USAGE);
		return 2;
	}

	if (cli.mode === 'status') {
		if (!existsSync(TASKS_ROOT)) {
			console.error(`no ${TASKS_ROOT} directory — no bench data to report (skipping)`);
			return 0;
		}
		console.error(formatStatus(buildStatus(TASKS_ROOT)));
		return 0;
	}

	if (cli.mode === 'claim') {
		const result = claimTask({ tasksRoot: TASKS_ROOT, slug: cli.slug, stratum: cli.stratum });
		if (!result.ok) {
			console.error(`error: ${result.error}`);
			return 2;
		}
		console.error(`claimed ${result.taskDir} as stratum "${cli.stratum}"`);
		return 0;
	}

	const result = createTask({
		tasksRoot: TASKS_ROOT,
		slug: cli.slug,
		entryUrl: cli.entryUrl,
		stratum: cli.stratum
	});
	if (!result.ok) {
		console.error(`error: ${result.error}`);
		return 2;
	}
	console.error(`created ${result.taskDir} (stratum "${cli.stratum}")`);
	console.error('next steps:');
	console.error(`  bun run bench:record ${result.taskDir} ${cli.entryUrl}`);
	console.error(`  bun run bench:serve ${result.taskDir} --port 8787`);
	console.error(`  bun run bench:lint ${result.taskDir}`);
	return 0;
}

if (import.meta.main) {
	process.exit(main());
}
