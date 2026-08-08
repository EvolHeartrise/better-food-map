/**
 * Authoring API for the bench viewer — the bench:review and bench:new
 * capabilities mounted under `/api/authoring/*` so all non-user-facing tools
 * live in one dashboard.
 *
 * WRITE POLICY — inputs, never evidence. These endpoints may write bench
 * INPUTS: `task.json`, `gold/draft.json`, `gold/data.json`,
 * `gold/review-state.json`. Nothing here may ever touch `bench/runs` — run
 * evidence stays immutable, which is the invariant that made the viewer
 * trustworthy in the first place (see the blacklist removal). Any new endpoint
 * added to this file must keep to that line.
 *
 * All task-addressed endpoints take a `?task=<slug>` (validated kebab-case,
 * resolved strictly inside the tasks root) rather than a path, so a request
 * can never traverse out of `bench/tasks`.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import * as v from 'valibot';
import type { GoldSchema} from './lint';
import { buildCorpus, lintGold, type LintResult } from './lint';
import { buildStatus, claimTask, createTask, isValidSlug, STRATA } from './new';
import {
	checkPromote,
	orderedPages,
	perItemHits,
	readablePageText,
	resolveReviewFile,
	validateSave,
	type FileChoice,
	type SavePayload
} from './review';
import { loadManifest, SnapshotStore, type BenchManifest } from './snapshot-store';

// --- per-task snapshot cache ----------------------------------------------------

interface TaskContext {
	manifest: BenchManifest;
	store: SnapshotStore;
	corpus: string;
	recordedUrls: Set<string>;
	pages: { url: string; title: string }[];
	/** Manifest mtime the context was built from; a re-record invalidates it. */
	manifestMtime: number;
}

/**
 * Corpus + recorded URLs per task, built once per snapshot version. bench:review
 * builds these at process start for its single task; the viewer serves every
 * task, so it caches by slug and invalidates on the manifest's mtime — a
 * re-recorded snapshot rewrites manifest.json last, so its mtime moves.
 */
export class TaskContextCache {
	private readonly contexts = new Map<string, TaskContext>();

	constructor(private readonly tasksDir: string) {}

	get(slug: string): TaskContext | null {
		const taskDir = join(this.tasksDir, slug);
		const manifestPath = join(taskDir, 'manifest.json');
		let mtime: number;
		try {
			mtime = statSync(manifestPath).mtimeMs;
		} catch {
			return null;
		}
		const cached = this.contexts.get(slug);
		if (cached && cached.manifestMtime === mtime) return cached;

		const manifest = loadManifest(taskDir);
		if (!manifest) return null;
		const store = new SnapshotStore(join(taskDir, 'snapshot'));
		const context: TaskContext = {
			manifest,
			store,
			corpus: buildCorpus(store),
			recordedUrls: new Set(
				store.index.entries.filter((e) => e.method === 'GET').map((e) => e.url)
			),
			pages: orderedPages(manifest),
			manifestMtime: mtime
		};
		this.contexts.set(slug, context);
		return context;
	}
}

// --- gold file I/O (mirrors bench:review, shared shapes) ------------------------

interface ReviewedContent {
	policy_version: string;
	sources: string[];
	items: SavePayload['items'];
}

function readContent(path: string): ReviewedContent {
	const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ReviewedContent>;
	return {
		policy_version: typeof raw.policy_version === 'string' ? raw.policy_version : 'draft',
		sources: Array.isArray(raw.sources) ? raw.sources : [],
		items: Array.isArray(raw.items) ? raw.items : []
	};
}

function readReviewed(taskDir: string): string[] {
	const path = join(taskDir, 'gold', 'review-state.json');
	if (!existsSync(path)) return [];
	try {
		const raw = JSON.parse(readFileSync(path, 'utf-8')) as { reviewed?: unknown };
		return Array.isArray(raw.reviewed)
			? raw.reviewed.filter((n): n is string => typeof n === 'string')
			: [];
	} catch {
		return [];
	}
}

function writeReviewed(taskDir: string, reviewed: string[]): void {
	mkdirSync(join(taskDir, 'gold'), { recursive: true });
	writeFileSync(
		join(taskDir, 'gold', 'review-state.json'),
		JSON.stringify({ reviewed }, null, '\t') + '\n'
	);
}

function writeGoldFile(path: string, content: ReviewedContent): void {
	writeFileSync(
		path,
		JSON.stringify(
			{ policy_version: content.policy_version, sources: content.sources, items: content.items },
			null,
			'\t'
		) + '\n'
	);
}

// --- request plumbing -----------------------------------------------------------

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
	});
}

/**
 * Resolve `?task=` to a directory strictly inside the tasks root. Slug syntax is
 * checked first (kebab-case only), and the resolved path is re-checked against
 * the root as belt and braces — a URL-decoded ".." must never become a path.
 */
function taskDirOf(tasksDir: string, slug: string | null): string | null {
	if (!slug || !isValidSlug(slug)) return null;
	const root = resolve(tasksDir);
	const dir = resolve(root, slug);
	if (!dir.startsWith(root + sep)) return null;
	return existsSync(dir) ? dir : null;
}

function fileChoiceOf(raw: string | null): FileChoice | undefined {
	return raw === 'draft' || raw === 'data' ? raw : undefined;
}

const CreateTaskSchema = v.object({
	slug: v.string(),
	entry_url: v.string(),
	stratum: v.string()
});

const ClaimTaskSchema = v.object({ slug: v.string(), stratum: v.string() });

const SaveBodySchema = v.object({
	task: v.string(),
	file: v.picklist(['draft', 'data']),
	// items/sources/reviewed validated by review.ts's validateSave below.
	items: v.unknown(),
	sources: v.optional(v.unknown()),
	reviewed: v.optional(v.unknown())
});

const PromoteSchema = v.object({ task: v.string(), policy_version: v.string() });

async function bodyOf(request: Request): Promise<unknown | Response> {
	try {
		return await request.json();
	} catch (e) {
		return json({ error: `invalid JSON body: ${String(e)}` }, 400);
	}
}

/** Lint the named gold file against the task's snapshot, or null when absent. */
function lintFile(
	taskDir: string,
	context: { corpus: string; recordedUrls: Set<string> },
	file: FileChoice
): LintResult | null {
	const path = join(taskDir, 'gold', `${file}.json`);
	if (!existsSync(path)) return null;
	try {
		return lintGold(JSON.parse(readFileSync(path, 'utf-8')), context.corpus, context.recordedUrls);
	} catch (e) {
		return { errors: [`unreadable ${file}.json: ${String(e)}`], warnings: [] };
	}
}

// --- handler --------------------------------------------------------------------

/**
 * Handle an `/api/authoring/*` request; null when the path is not ours so the
 * caller falls through to its own routing (and its own 404).
 */
export async function handleAuthoring(
	request: Request,
	url: URL,
	tasksDir: string,
	cache: TaskContextCache
): Promise<Response | null> {
	const { pathname } = url;
	if (!pathname.startsWith('/api/authoring/')) return null;

	switch (pathname) {
		/** Strata matrix + per-task authoring state — bench:new --status as JSON. */
		case '/api/authoring/status': {
			if (!existsSync(tasksDir)) return json({ strata: STRATA, by_stratum: [], tasks: [] });
			const status = buildStatus(tasksDir);
			return json({
				strata: STRATA,
				by_stratum: status.byStratum,
				tasks: status.rows.map((row) => {
					const taskDir = join(tasksDir, row.slug);
					const entry = readTaskEntryUrl(taskDir);
					return { ...row, entry_url: entry };
				})
			});
		}

		/** Full review state for one task — bench:review /api/state, task-addressed. */
		case '/api/authoring/task': {
			const slug = url.searchParams.get('task');
			const taskDir = taskDirOf(tasksDir, slug);
			if (!taskDir) return json({ error: `no such task: ${slug}` }, 404);
			const context = cache.get(slug as string);
			if (!context) return json({ error: `no snapshot recorded for ${slug}` }, 409);
			const resolved = resolveReviewFile(taskDir, fileChoiceOf(url.searchParams.get('file')));
			if (!resolved.ok) return json({ error: resolved.error }, 404);
			const content = readContent(resolved.path);
			return json({
				task: slug,
				file: resolved.file,
				can_promote: resolved.file === 'draft',
				policy_version: content.policy_version,
				sources: content.sources,
				items: content.items,
				reviewed: readReviewed(taskDir),
				pages: context.pages,
				per_item: perItemHits(content.items, context.corpus),
				lint: lintFile(taskDir, context, resolved.file)
			});
		}

		/** One crawled page as readable text. */
		case '/api/authoring/page': {
			const slug = url.searchParams.get('task');
			const target = url.searchParams.get('url');
			const taskDir = taskDirOf(tasksDir, slug);
			if (!taskDir) return json({ error: `no such task: ${slug}` }, 404);
			if (!target) return json({ error: 'missing url' }, 400);
			const context = cache.get(slug as string);
			if (!context) return json({ error: `no snapshot recorded for ${slug}` }, 409);
			return json({ url: target, text: readablePageText(context.store, target) });
		}

		/** Save the reviewed gold file + review-state (inputs, never evidence). */
		case '/api/authoring/save': {
			if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
			const body = await bodyOf(request);
			if (body instanceof Response) return body;
			const parsed = v.safeParse(SaveBodySchema, body);
			if (!parsed.success) return json({ error: 'invalid body: task and file required' }, 400);
			const taskDir = taskDirOf(tasksDir, parsed.output.task);
			if (!taskDir) return json({ error: `no such task: ${parsed.output.task}` }, 404);
			const target = join(taskDir, 'gold', `${parsed.output.file}.json`);
			if (!existsSync(target)) {
				return json({ error: `no gold/${parsed.output.file}.json to save over` }, 409);
			}
			const validation = validateSave({
				items: parsed.output.items,
				sources: parsed.output.sources,
				reviewed: parsed.output.reviewed
			});
			if (!validation.ok) return json({ error: 'invalid items', issues: validation.issues }, 400);
			const existing = readContent(target);
			writeGoldFile(target, {
				policy_version: existing.policy_version,
				sources: validation.value.sources ?? existing.sources,
				items: validation.value.items
			});
			writeReviewed(taskDir, validation.value.reviewed ?? []);
			const context = cache.get(parsed.output.task);
			return json({
				ok: true,
				per_item: context ? perItemHits(validation.value.items, context.corpus) : []
			});
		}

		/** Promote draft → data, gated on a zero-error lint (bench:review parity). */
		case '/api/authoring/promote': {
			if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
			const body = await bodyOf(request);
			if (body instanceof Response) return body;
			const parsed = v.safeParse(PromoteSchema, body);
			if (!parsed.success) return json({ error: 'task and policy_version required' }, 400);
			if (!parsed.output.policy_version) return json({ error: 'policy_version is required' }, 400);
			const taskDir = taskDirOf(tasksDir, parsed.output.task);
			if (!taskDir) return json({ error: `no such task: ${parsed.output.task}` }, 404);
			const draftPath = join(taskDir, 'gold', 'draft.json');
			if (!existsSync(draftPath)) {
				return json({ error: 'promote is only valid while a gold/draft.json exists' }, 400);
			}
			const context = cache.get(parsed.output.task);
			if (!context) return json({ error: `no snapshot recorded for ${parsed.output.task}` }, 409);
			const content = readContent(draftPath);
			const lint = checkPromote(
				content,
				parsed.output.policy_version,
				context.corpus,
				context.recordedUrls
			);
			if (lint.errors.length > 0) {
				return json({ error: 'lint errors remain', errors: lint.errors }, 409);
			}
			writeGoldFile(join(taskDir, 'gold', 'data.json'), {
				policy_version: parsed.output.policy_version,
				sources: content.sources,
				items: content.items
			});
			return json({ ok: true, warnings: lint.warnings });
		}

		/** Scaffold a new task dir (no crawl — bench:record is still the next step). */
		case '/api/authoring/create': {
			if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
			const body = await bodyOf(request);
			if (body instanceof Response) return body;
			const parsed = v.safeParse(CreateTaskSchema, body);
			if (!parsed.success) return json({ error: 'slug, entry_url, stratum required' }, 400);
			const result = createTask({
				tasksRoot: tasksDir,
				slug: parsed.output.slug,
				entryUrl: parsed.output.entry_url,
				stratum: parsed.output.stratum
			});
			if (!result.ok) return json({ error: result.error }, 400);
			return json({ ok: true, task_dir: result.taskDir });
		}

		/** Stamp a stratum onto an existing (pre-tooling) task dir. */
		case '/api/authoring/claim': {
			if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
			const body = await bodyOf(request);
			if (body instanceof Response) return body;
			const parsed = v.safeParse(ClaimTaskSchema, body);
			if (!parsed.success) return json({ error: 'slug and stratum required' }, 400);
			const result = claimTask({
				tasksRoot: tasksDir,
				slug: parsed.output.slug,
				stratum: parsed.output.stratum
			});
			if (!result.ok) return json({ error: result.error }, 400);
			return json({ ok: true, task_dir: result.taskDir });
		}

		default:
			return json({ error: `no such endpoint: ${pathname}` }, 404);
	}
}

/** entry_url from task.json, falling back to the manifest; empty when neither. */
function readTaskEntryUrl(taskDir: string): string {
	try {
		const raw = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf-8')) as {
			entry_url?: unknown;
		};
		if (typeof raw.entry_url === 'string' && raw.entry_url) return raw.entry_url;
	} catch {
		// fall through to the manifest
	}
	return loadManifest(taskDir)?.entryUrl ?? '';
}

/** GoldSchema re-export so the SPA's types can mirror the item shape via one hop. */
export type GoldItems = v.InferOutput<typeof GoldSchema>['items'];
