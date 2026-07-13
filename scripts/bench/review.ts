/**
 * Bench gold-review UI.
 *
 * Serves a local two-pane web app for hand-reviewing a machine-drafted gold
 * against the task's frozen snapshot. The LEFT pane shows each crawled page as
 * extracted, readable text (menu-shaped pages first); the RIGHT pane is the
 * editable item list from the reviewed file. Clicking an item highlights and
 * scrolls to its name in the snapshot text — an item whose name appears NOWHERE
 * gets a loud badge, which is the draft's main failure mode (rewritten names).
 * The core loop: edit the name until the badge clears.
 *
 * Review progress (which items are marked "reviewed") lives OUTSIDE the gold in
 * gold/review-state.json so the gold format stays lean. Promoting a draft runs
 * the gold linter and refuses while ERRORS remain (a zero-hit name is an error).
 *
 * Usage:
 *   bun run bench:review <task-dir> [--port 8790] [--file draft|data]
 *
 * All human output goes to stderr. Exit 2 on a usage error or when neither
 * gold/draft.json nor gold/data.json exists.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import {
	buildCorpus,
	GoldSchema,
	htmlToText,
	type LintResult,
	lintGold,
	normalizeForSearch,
	stripVariantSuffix
} from './lint';
import {
	findEntry,
	isTextType,
	loadManifest,
	type BenchManifest,
	SnapshotStore
} from './snapshot-store';

// Menu-shaped URLs sort to the front of the tab strip so the reviewer opens the
// food pages first. Kept local (a copy of record.ts's hint) so the review UI
// never pulls the headless-browser recorder into its runtime.
const MENU_HINT =
	/menu|food|drink|beverage|wine|beer|cocktail|dessert|brunch|lunch|dinner|breakfast|order|eat|takeout|take-out|catering|nutrition|allergen/i;

// --- pure helpers -------------------------------------------------------------

export type FileChoice = 'draft' | 'data';

export type FileResolution =
	| { ok: true; file: FileChoice; path: string }
	| { ok: false; error: string };

/**
 * Resolve which gold file to review. An explicit `--file` requires that file to
 * exist; the default prefers gold/draft.json, falls back to gold/data.json, and
 * fails (the CLI exits 2) when neither exists.
 */
export function resolveReviewFile(taskDir: string, requested?: FileChoice): FileResolution {
	const draftPath = join(taskDir, 'gold', 'draft.json');
	const dataPath = join(taskDir, 'gold', 'data.json');
	if (requested === 'draft') {
		return existsSync(draftPath)
			? { ok: true, file: 'draft', path: draftPath }
			: { ok: false, error: `no gold/draft.json in ${taskDir}` };
	}
	if (requested === 'data') {
		return existsSync(dataPath)
			? { ok: true, file: 'data', path: dataPath }
			: { ok: false, error: `no gold/data.json in ${taskDir}` };
	}
	if (existsSync(draftPath)) return { ok: true, file: 'draft', path: draftPath };
	if (existsSync(dataPath)) return { ok: true, file: 'data', path: dataPath };
	return { ok: false, error: `no gold/draft.json or gold/data.json in ${taskDir}` };
}

// The save payload validates the item list against the gold vocabulary but is
// policy_version-free — the reviewed file's policy_version is preserved on write,
// never sent by the client. Sources and the reviewed-name list ride along.
export const SaveSchema = v.object({
	items: GoldSchema.entries.items,
	sources: v.optional(GoldSchema.entries.sources),
	reviewed: v.optional(v.array(v.string()))
});

export type SavePayload = v.InferOutput<typeof SaveSchema>;

export type SaveValidation = { ok: true; value: SavePayload } | { ok: false; issues: string[] };

/** Validate a /api/save body against SaveSchema, returning dot-path issues on failure. */
export function validateSave(body: unknown): SaveValidation {
	const parsed = v.safeParse(SaveSchema, body);
	if (parsed.success) return { ok: true, value: parsed.output };
	return {
		ok: false,
		issues: parsed.issues
			.slice(0, 20)
			.map((issue) => `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`)
	};
}

export interface ItemHit {
	nameFound: boolean;
	descFound: boolean;
}

/**
 * Per-item snapshot hit status against the normalized corpus: `nameFound` is the
 * core signal (a false is the loud "rewritten name" badge); `descFound` is true
 * for a null description (nothing to verify) else whether the text appears.
 */
export function perItemHits(
	items: readonly { name: string; description: string | null }[],
	corpus: string
): ItemHit[] {
	return items.map((item) => {
		const base = stripVariantSuffix(item.name);
		return {
			nameFound:
				corpus.includes(normalizeForSearch(item.name)) ||
				(base !== undefined && corpus.includes(normalizeForSearch(base))),
			descFound:
				item.description === null ? true : corpus.includes(normalizeForSearch(item.description))
		};
	});
}

/**
 * Promote gate: lint the draft content stamped with the chosen policy_version
 * against the snapshot. Promotion is allowed only when there are zero errors
 * (warnings are fine).
 */
export function checkPromote(
	content: { sources: string[]; items: SavePayload['items'] },
	policyVersion: string,
	corpus: string,
	recordedUrls: Set<string>
): LintResult {
	return lintGold(
		{ policy_version: policyVersion, sources: content.sources, items: content.items },
		corpus,
		recordedUrls
	);
}

/**
 * Menu-shaped by URL PATH only — testing the whole URL would match on a host that
 * happens to contain a hint word (e.g. "eatmeet.ca" contains "eat"/"meet"), which
 * would flatten the ordering. An unparseable URL is treated as not menu-shaped.
 */
function isMenuShaped(url: string): boolean {
	try {
		return MENU_HINT.test(new URL(url).pathname);
	} catch {
		return MENU_HINT.test(url);
	}
}

/** Manifest pages (url + title) ordered menu-shaped first, otherwise stable. */
export function orderedPages(manifest: BenchManifest): { url: string; title: string }[] {
	return manifest.pages
		.map((p) => ({ url: p.url, title: p.title }))
		.toSorted((a, b) => Number(isMenuShaped(b.url)) - Number(isMenuShaped(a.url)));
}

/** Rendered/raw HTML → readable text: block tags become line breaks, runs of inline space collapse. */
export function htmlToReadableText(html: string): string {
	const withBreaks = html
		.replace(/<(?:br|hr)\s*\/?>/gi, '\n')
		.replace(
			/<\/(?:p|div|li|ul|ol|tr|table|section|article|h[1-6]|header|footer|nav|td|th|dt|dd|blockquote)>/gi,
			'\n'
		);
	return htmlToText(withBreaks)
		.split('\n')
		.map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
		.filter((line) => line.length > 0)
		.join('\n');
}

/** Extract one crawled page's readable text (rendered DOM preferred, then a text body). */
export function readablePageText(store: SnapshotStore, url: string): string {
	const entry = findEntry(store.index, 'GET', url);
	if (!entry) return '';
	const rendered = store.renderedHtml(entry);
	if (rendered) return htmlToReadableText(rendered);
	const body = store.body(entry);
	if (!body) return '';
	const text = new TextDecoder().decode(body);
	if (entry.contentType?.includes('html')) return htmlToReadableText(text);
	if (isTextType(entry.contentType)) {
		return text
			.split('\n')
			.map((line) => line.replace(/[^\S\n]+/g, ' ').trimEnd())
			.filter((line) => line.trim().length > 0)
			.join('\n');
	}
	return '';
}

// --- reviewed-file + review-state I/O -----------------------------------------

interface ReviewedContent {
	policy_version: string;
	sources: string[];
	items: SavePayload['items'];
}

/** Read the reviewed gold file (draft.json or data.json) as-is. */
function readContent(path: string): ReviewedContent {
	const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ReviewedContent>;
	return {
		policy_version: typeof raw.policy_version === 'string' ? raw.policy_version : 'draft',
		sources: Array.isArray(raw.sources) ? raw.sources : [],
		items: Array.isArray(raw.items) ? raw.items : []
	};
}

/** Read the reviewed-name list from gold/review-state.json (empty when absent). */
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
	const path = join(taskDir, 'gold', 'review-state.json');
	writeFileSync(path, JSON.stringify({ reviewed }, null, '\t') + '\n');
}

// --- CLI parsing --------------------------------------------------------------

export interface CliArgs {
	taskDir: string;
	port: number;
	file?: FileChoice;
}

export function parseCli(argv: string[]): CliArgs | { error: string } {
	let taskDir: string | undefined;
	let port = 8790;
	let file: FileChoice | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--port') {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n <= 0) return { error: '--port must be a positive integer' };
			port = n;
		} else if (arg === '--file') {
			const value = argv[++i];
			if (value !== 'draft' && value !== 'data')
				return { error: "--file must be 'draft' or 'data'" };
			file = value;
		} else if (arg.startsWith('--')) {
			return { error: `unknown option: ${arg}` };
		} else if (taskDir === undefined) {
			taskDir = arg;
		} else {
			return { error: `unexpected argument: ${arg}` };
		}
	}
	if (!taskDir) return { error: 'missing <task-dir>' };
	return { taskDir, port, file };
}

const USAGE = 'usage: bun run bench:review <task-dir> [--port 8790] [--file draft|data]';

// --- server -------------------------------------------------------------------

function main(): number {
	const cli = parseCli(process.argv.slice(2));
	if ('error' in cli) {
		console.error(`error: ${cli.error}`);
		console.error(USAGE);
		return 2;
	}

	const manifest = loadManifest(cli.taskDir);
	if (!manifest) {
		console.error(`error: no manifest.json in ${cli.taskDir} — record a snapshot first`);
		return 2;
	}

	const resolved = resolveReviewFile(cli.taskDir, cli.file);
	if (!resolved.ok) {
		console.error(`error: ${resolved.error}`);
		return 2;
	}

	const store = new SnapshotStore(join(cli.taskDir, 'snapshot'));
	// Corpus + recorded URLs are static (the snapshot never changes here), so
	// build them once at startup and reuse across requests.
	const corpus = buildCorpus(store);
	const recordedUrls = new Set(
		store.index.entries.filter((e) => e.method === 'GET').map((e) => e.url)
	);
	const pages = orderedPages(manifest);
	const dataPath = join(cli.taskDir, 'gold', 'data.json');

	mkdirSync(join(cli.taskDir, 'gold'), { recursive: true });

	const server = Bun.serve({
		port: cli.port,
		fetch: async (req) => {
			const url = new URL(req.url);

			if (url.pathname === '/') {
				return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
			}

			if (url.pathname === '/api/state') {
				const content = readContent(resolved.path);
				return Response.json({
					file: resolved.file,
					canPromote: resolved.file === 'draft',
					policy_version: content.policy_version,
					sources: content.sources,
					items: content.items,
					reviewed: readReviewed(cli.taskDir),
					pages,
					perItem: perItemHits(content.items, corpus)
				});
			}

			if (url.pathname === '/api/page') {
				const target = url.searchParams.get('url');
				if (!target) return Response.json({ error: 'missing url' }, { status: 400 });
				return Response.json({ url: target, text: readablePageText(store, target) });
			}

			if (url.pathname === '/api/save' && req.method === 'POST') {
				let body: unknown;
				try {
					body = await req.json();
				} catch (e) {
					return Response.json({ error: `invalid JSON: ${String(e)}` }, { status: 400 });
				}
				const validation = validateSave(body);
				if (!validation.ok) {
					return Response.json(
						{ error: 'invalid items', issues: validation.issues },
						{ status: 400 }
					);
				}
				const existing = readContent(resolved.path);
				const items = validation.value.items;
				writeFileSync(
					resolved.path,
					JSON.stringify(
						{
							policy_version: existing.policy_version,
							sources: validation.value.sources ?? existing.sources,
							items
						},
						null,
						'\t'
					) + '\n'
				);
				writeReviewed(cli.taskDir, validation.value.reviewed ?? []);
				return Response.json({ ok: true, perItem: perItemHits(items, corpus) });
			}

			if (url.pathname === '/api/promote' && req.method === 'POST') {
				if (resolved.file !== 'draft') {
					return Response.json(
						{ error: 'promote is only valid while reviewing draft.json' },
						{ status: 400 }
					);
				}
				let body: { policy_version?: unknown };
				try {
					body = (await req.json()) as { policy_version?: unknown };
				} catch (e) {
					return Response.json({ error: `invalid JSON: ${String(e)}` }, { status: 400 });
				}
				const policyVersion = typeof body.policy_version === 'string' ? body.policy_version : '';
				if (!policyVersion) {
					return Response.json({ error: 'policy_version is required' }, { status: 400 });
				}
				const content = readContent(resolved.path);
				const lint = checkPromote(content, policyVersion, corpus, recordedUrls);
				if (lint.errors.length > 0) {
					return Response.json(
						{ error: 'lint errors remain', errors: lint.errors },
						{ status: 409 }
					);
				}
				writeFileSync(
					dataPath,
					JSON.stringify(
						{ policy_version: policyVersion, sources: content.sources, items: content.items },
						null,
						'\t'
					) + '\n'
				);
				return Response.json({ ok: true, warnings: lint.warnings, wrote: dataPath });
			}

			return new Response('not found\n', { status: 404 });
		}
	});

	const startCount = readContent(resolved.path).items.length;
	console.error(`bench:review — ${cli.taskDir} (reviewing gold/${resolved.file}.json)`);
	console.error(`  ${server.url.href}`);
	console.error(`  ${startCount} items, ${pages.length} pages`);
	return 0;
}

if (import.meta.main) {
	const code = main();
	// A non-zero code is a startup failure; 0 means Bun.serve is now running, so
	// leave the process alive (exiting would kill the server) until interrupted.
	if (code !== 0) process.exit(code);
}

// --- embedded UI --------------------------------------------------------------

const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>bench:review</title>
<style>
	:root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#ddd; --card:#f7f7f7; --accent:#2563eb; --bad:#c62828; --good:#2e7d32; --mark:#ffe58a; }
	@media (prefers-color-scheme: dark) { :root { --bg:#16181c; --fg:#e6e6e6; --muted:#9aa0aa; --line:#333; --card:#20242b; --accent:#5b9dff; --bad:#ff6b6b; --good:#6fcf6f; --mark:#7a5b00; } }
	* { box-sizing: border-box; }
	body { margin:0; font:14px/1.45 system-ui, sans-serif; color:var(--fg); background:var(--bg); }
	header { padding:8px 12px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:center; flex-wrap:wrap; position:sticky; top:0; background:var(--bg); z-index:5; }
	header .stat { font-variant-numeric: tabular-nums; }
	header .bad { color:var(--bad); font-weight:600; }
	#save { color:var(--muted); }
	#save.dirty { color:var(--bad); }
	#save.saved { color:var(--good); }
	button { font:inherit; padding:3px 8px; border:1px solid var(--line); border-radius:5px; background:var(--card); color:var(--fg); cursor:pointer; }
	button:hover { border-color:var(--accent); }
	button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
	button:disabled { opacity:.5; cursor:not-allowed; }
	main { display:grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 52px); }
	#left, #right { overflow:auto; height:100%; }
	#left { border-right:1px solid var(--line); }
	#tabs { display:flex; flex-wrap:wrap; gap:4px; padding:8px; position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); }
	#tabs button { font-size:12px; }
	#tabs button.active { background:var(--accent); color:#fff; border-color:var(--accent); }
	#pagetext { padding:12px; white-space:pre-wrap; word-break:break-word; font:13px/1.5 ui-monospace, monospace; }
	mark { background:var(--mark); color:inherit; padding:0 1px; border-radius:2px; }
	.item { border:1px solid var(--line); border-radius:8px; margin:8px; padding:8px; background:var(--card); }
	.item.zero { border-color:var(--bad); box-shadow:0 0 0 1px var(--bad) inset; }
	.item.reviewed { opacity:.7; }
	.item .row1 { display:flex; gap:8px; align-items:center; }
	.item input[type=text], .item textarea, .item input.price { width:100%; font:inherit; padding:4px; border:1px solid var(--line); border-radius:4px; background:var(--bg); color:var(--fg); }
	.item textarea { resize:vertical; min-height:34px; }
	.item .name { font-weight:600; }
	.item .meta { display:flex; gap:10px; align-items:center; margin-top:6px; flex-wrap:wrap; }
	.item .price { width:90px; }
	.item .tags { display:flex; gap:8px; flex-wrap:wrap; font-size:12px; }
	.item .tags label { display:inline-flex; gap:3px; align-items:center; }
	.item .tags fieldset { border:1px dashed var(--line); border-radius:6px; padding:4px 6px; margin:0; }
	.item .tags legend { font-size:11px; color:var(--muted); padding:0 4px; }
	.badge { font-size:11px; font-weight:700; color:#fff; background:var(--bad); padding:1px 6px; border-radius:10px; }
	.hint { color:var(--muted); font-size:12px; }
	.del { color:var(--bad); border-color:var(--bad); }
	#sources { width:280px; height:34px; font:12px ui-monospace, monospace; vertical-align:middle; }
	label.rev { display:inline-flex; gap:4px; align-items:center; font-size:12px; }
	#promotebox { margin-left:auto; display:flex; gap:8px; align-items:center; }
	#promoteout { font-size:12px; max-width:340px; max-height:80px; overflow:auto; }
	#promoteout.err { color:var(--bad); }
	#promoteout.ok { color:var(--good); }
</style>
</head>
<body>
<header>
	<strong>bench:review</strong>
	<span class="stat" id="progress">…</span>
	<span id="save">loaded</span>
	<label class="hint">sources<br><textarea id="sources" spellcheck="false"></textarea></label>
	<span id="promotebox">
		<label class="hint">policy_version <input type="text" id="pv" size="12" /></label>
		<button class="primary" id="promote">Promote</button>
	</span>
	<span id="promoteout"></span>
</header>
<main>
	<section id="left">
		<div id="tabs"></div>
		<div id="pagetext"></div>
	</section>
	<section id="right"></section>
</main>
<script>
const TAGS = ['vegan','vegetarian','gluten_free','dairy_free','nut_free','halal'];
let state = null;
const pageText = new Map();   // url -> raw text
const pageNorm = new Map();   // url -> normalized text
let activeTab = 0;
let saveTimer = null;

const norm = (s) => (s||'').toLowerCase().replace(/\s+/g,' ').trim();
// Mirror of lint.ts stripVariantSuffix: one TRAILING "(…)" group off, base or null.
const stripVariant = (s) => { const b = (s||'').replace(/\s*\([^()]*\)$/, ''); return b.length > 0 && b !== s ? b : null; };
const esc = (s) => s.replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const escRe = (s) => s.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');

function todayISO() { return new Date().toISOString().slice(0,10); }

async function boot() {
	const res = await fetch('/api/state');
	state = await res.json();
	document.getElementById('sources').value = (state.sources||[]).join('\n');
	document.getElementById('pv').value = state.policy_version === 'draft' ? todayISO() : state.policy_version;
	document.getElementById('promote').disabled = !state.canPromote;
	// fetch every page's text so hit status recomputes live and offline
	await Promise.all(state.pages.map(async (p) => {
		const r = await fetch('/api/page?url=' + encodeURIComponent(p.url));
		const j = await r.json();
		pageText.set(p.url, j.text || '');
		pageNorm.set(p.url, norm(j.text || ''));
	}));
	renderTabs();
	renderLeft(null);
	renderItems();
	updateProgress();
}

// first page index whose normalized text contains the (normalized) name, else -1.
// A variant name "Fresh Soup (bowl)" also matches on its base "Fresh Soup".
function pageOf(name) {
	const n = norm(name);
	if (!n) return -1;
	const base = stripVariant(name);
	const nb = base ? norm(base) : null;
	for (let i = 0; i < state.pages.length; i++) {
		const t = pageNorm.get(state.pages[i].url);
		if (t.includes(n) || (nb && t.includes(nb))) return i;
	}
	return -1;
}

function renderTabs() {
	const tabs = document.getElementById('tabs');
	tabs.innerHTML = '';
	state.pages.forEach((p, i) => {
		const b = document.createElement('button');
		b.textContent = p.title || p.url;
		b.title = p.url;
		if (i === activeTab) b.className = 'active';
		b.onclick = () => { activeTab = i; renderTabs(); renderLeft(null); };
		tabs.appendChild(b);
	});
}

// Highlight the first match of the needle in the escaped page html; returns the
// html with mark tags, or null when the needle matched nothing.
function markInto(escaped, needle) {
	const n = esc(needle).trim();
	if (!n) return null;
	const re = new RegExp(escRe(n).replace(/(?:\\?\s)+/g, '\\s+'), 'gi');
	let first = true;
	let matched = false;
	const out = escaped.replace(re, (m) => {
		matched = true;
		const id = first ? ' id="firsthit"' : '';
		first = false;
		return '<mark' + id + '>' + m + '</mark>';
	});
	return matched ? out : null;
}

function renderLeft(highlight) {
	const el = document.getElementById('pagetext');
	const raw = pageText.get(state.pages[activeTab].url) || '';
	if (!highlight) { el.innerHTML = esc(raw); return; }
	const escaped = esc(raw);
	// Try the full name; when it has no hits, fall back to the variant base
	// (mirrors the full-or-stripped-base rule in perItemHits / lintGold).
	const base = stripVariant(highlight);
	const marked = markInto(escaped, highlight) ?? (base ? markInto(escaped, base) : null);
	el.innerHTML = marked ?? escaped;
	const target = document.getElementById('firsthit');
	if (target) target.scrollIntoView({ block: 'center' });
}

function focusItem(idx) {
	const name = state.items[idx].name;
	const p = pageOf(name);
	if (p >= 0 && p !== activeTab) { activeTab = p; renderTabs(); }
	renderLeft(name);
}

function markDirty() {
	const s = document.getElementById('save');
	s.textContent = 'unsaved'; s.className = 'dirty';
	clearTimeout(saveTimer);
	saveTimer = setTimeout(save, 700);
}

function renderItems() {
	const right = document.getElementById('right');
	right.innerHTML = '';
	const reviewed = new Set(state.reviewed || []);
	state.items.forEach((item, idx) => {
		const zero = pageOf(item.name) < 0;
		const card = document.createElement('div');
		card.className = 'item' + (zero ? ' zero' : '') + (reviewed.has(item.name) ? ' reviewed' : '');

		const row1 = document.createElement('div');
		row1.className = 'row1';
		const name = document.createElement('input');
		name.type = 'text'; name.className = 'name'; name.value = item.name;
		name.oninput = () => {
			item.name = name.value;
			const nowZero = pageOf(item.name) < 0;
			card.classList.toggle('zero', nowZero);
			badge.style.display = nowZero ? '' : 'none';
			updateProgress();
			markDirty();
		};
		name.onfocus = () => focusItem(idx);
		const badge = document.createElement('span');
		badge.className = 'badge'; badge.textContent = 'NO HITS';
		badge.style.display = zero ? '' : 'none';
		const del = document.createElement('button');
		del.className = 'del'; del.textContent = 'Delete';
		del.onclick = () => { state.items.splice(idx, 1); renderItems(); updateProgress(); markDirty(); };
		row1.append(name, badge, del);

		const desc = document.createElement('textarea');
		desc.placeholder = 'description (verbatim, or leave blank for null)';
		desc.value = item.description == null ? '' : item.description;
		desc.oninput = () => { item.description = desc.value.trim() === '' ? null : desc.value; markDirty(); };

		const meta = document.createElement('div');
		meta.className = 'meta';
		const price = document.createElement('input');
		price.type = 'text'; price.className = 'price'; price.placeholder = 'price';
		price.value = item.price == null ? '' : String(item.price);
		price.oninput = () => {
			const t = price.value.trim();
			item.price = t === '' ? null : (isNaN(Number(t)) ? t : Number(t));
			markDirty();
		};
		const warn = document.createElement('input');
		warn.type = 'text'; warn.placeholder = 'warning (optional)'; warn.style.flex = '1';
		warn.value = item.warning == null ? '' : item.warning;
		warn.oninput = () => { item.warning = warn.value.trim() === '' ? null : warn.value; markDirty(); };
		const rev = document.createElement('label');
		rev.className = 'rev';
		const revcb = document.createElement('input');
		revcb.type = 'checkbox'; revcb.checked = reviewed.has(item.name);
		revcb.onchange = () => {
			const set = new Set(state.reviewed || []);
			if (revcb.checked) set.add(item.name); else set.delete(item.name);
			state.reviewed = [...set];
			card.classList.toggle('reviewed', revcb.checked);
			updateProgress();
			markDirty();
		};
		rev.append(revcb, document.createTextNode('reviewed'));
		meta.append(price, warn, rev);

		const tags = document.createElement('div');
		tags.className = 'tags';
		tags.append(tagGroup('tags', item, markDirty), tagGroup('optional_tags', item, markDirty));

		card.append(row1, desc, meta, tags);
		right.appendChild(card);
	});
}

function tagGroup(field, item, onchange) {
	const fs = document.createElement('fieldset');
	const lg = document.createElement('legend');
	lg.textContent = field === 'tags' ? 'tags' : 'optional';
	fs.appendChild(lg);
	item[field] = Array.isArray(item[field]) ? item[field] : [];
	TAGS.forEach((tag) => {
		const lbl = document.createElement('label');
		const cb = document.createElement('input');
		cb.type = 'checkbox'; cb.checked = item[field].includes(tag);
		cb.onchange = () => {
			const set = new Set(item[field]);
			if (cb.checked) set.add(tag); else set.delete(tag);
			item[field] = TAGS.filter((t) => set.has(t));
			onchange();
		};
		lbl.append(cb, document.createTextNode(tag.replace('_',' ')));
		fs.appendChild(lbl);
	});
	return fs;
}

function updateProgress() {
	const total = state.items.length;
	const reviewed = new Set(state.reviewed || []);
	const revCount = state.items.filter((i) => reviewed.has(i.name)).length;
	const zero = state.items.filter((i) => pageOf(i.name) < 0).length;
	const el = document.getElementById('progress');
	el.innerHTML = 'reviewed ' + revCount + '/' + total +
		'  •  <span class="' + (zero ? 'bad' : '') + '">zero-hit ' + zero + '</span>';
}

async function save() {
	const s = document.getElementById('save');
	s.textContent = 'saving…'; s.className = '';
	const sources = document.getElementById('sources').value.split('\n').map((x) => x.trim()).filter(Boolean);
	const res = await fetch('/api/save', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ items: state.items, sources, reviewed: state.reviewed || [] })
	});
	if (!res.ok) {
		const j = await res.json().catch(() => ({}));
		s.textContent = 'save failed: ' + ((j.issues || [j.error]).join('; '));
		s.className = 'dirty';
		return;
	}
	s.textContent = 'saved'; s.className = 'saved';
}

document.getElementById('sources').addEventListener('input', markDirty);

document.getElementById('promote').onclick = async () => {
	const out = document.getElementById('promoteout');
	out.className = ''; out.textContent = 'promoting…';
	await save();
	const res = await fetch('/api/promote', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ policy_version: document.getElementById('pv').value.trim() })
	});
	const j = await res.json().catch(() => ({}));
	if (res.ok) {
		out.className = 'ok';
		out.textContent = 'promoted → gold/data.json' + ((j.warnings||[]).length ? ' (' + j.warnings.length + ' warning(s))' : '');
	} else {
		out.className = 'err';
		out.textContent = (j.error || 'failed') + ': ' + ((j.errors || j.issues || []).slice(0,20).join(' | '));
	}
};

boot();
</script>
</body>
</html>`;
