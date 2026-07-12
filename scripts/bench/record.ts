/**
 * Bench snapshot recorder.
 *
 * Crawls a venue's website with headless Chromium, recording EVERY network
 * response (any host — that's how ordering-API JSON and PDFs get captured)
 * plus the post-JS rendered DOM of each navigated page, into a replayable
 * snapshot under the task directory. Re-running merges into the existing
 * snapshot, replacing stale responses and appending new ones.
 *
 * Usage:
 *   bun run bench:record <task-dir> <entry-url> [options]
 *   bun run bench:record bench/tasks/meet-on-main https://meetonmain.com
 *
 * Options:
 *   --url <url>        extra URL to visit (repeatable; also accepts cross-origin)
 *   --max-pages <n>    navigation budget (default 40)
 *   --max-depth <n>    link depth from entry (default 4; --url entries are depth 0)
 *   --wait <ms>        extra settle time per page after network idle (default 1500)
 *   --headed           open a visible browser (for click-gated content, watch it work)
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import {
	loadManifest,
	normalizeUrl,
	saveManifest,
	SnapshotStore,
	type BenchManifest
} from './snapshot-store';

export function findChromium(): string {
	const override = process.env.BENCH_CHROME;
	if (override) return override;
	const root = join(homedir(), '.cache', 'ms-playwright');
	const dirs = readdirSync(root);
	const pick = (prefix: string, ...rels: string[]) => {
		const versions = dirs
			.filter((d) => d.startsWith(prefix))
			.map((d) => ({ d, n: Number(d.slice(prefix.length)) }))
			.toSorted((a, b) => b.n - a.n);
		for (const v of versions) {
			for (const rel of rels) {
				const p = join(root, v.d, rel);
				if (existsSync(p)) return p;
			}
		}
		return undefined;
	};
	const found =
		pick('chromium-', 'chrome-linux64/chrome', 'chrome-linux/chrome') ??
		pick('chromium_headless_shell-', 'chrome-headless-shell-linux64/chrome-headless-shell');
	if (!found) throw new Error(`no cached Chromium under ${root}; set BENCH_CHROME`);
	return found;
}

const MENU_HINT =
	/menu|food|drink|beverage|wine|beer|cocktail|dessert|brunch|lunch|dinner|breakfast|order|eat|takeout|take-out|catering|nutrition|allergen/i;
const SKIP_EXT = /\.(png|jpe?g|webp|gif|svg|ico|css|js|woff2?|ttf|mp4|webm|zip)(\?|$)/i;
// Tested against the page TITLE and visible body text only — never raw HTML,
// where anti-bot SDK script tags (Wix/Cloudflare embed reCAPTCHA on every page)
// would make this fire on perfectly readable pages.
const BOT_WALL =
	/just a moment|access denied|verify you are human|attention required|are you a robot|pardon our interruption|enable javascript and cookies/i;

/** True when the page a human sees is a challenge page, not the venue's content. */
export function looksLikeBotWall(status: number, title: string, visibleText: string): boolean {
	if (status === 403 || status === 429 || status === 503) return true;
	return BOT_WALL.test(title) || BOT_WALL.test(visibleText.slice(0, 2000));
}

export function extractLinks(hrefs: string[], baseUrl: string, primaryHost: string): string[] {
	const out = new Set<string>();
	for (const href of hrefs) {
		let u: URL;
		try {
			u = new URL(href, baseUrl);
		} catch {
			continue;
		}
		if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
		if (u.host.toLowerCase() !== primaryHost) continue;
		if (SKIP_EXT.test(u.pathname)) continue;
		out.add(normalizeUrl(u.href));
	}
	return [...out];
}

/** Menu-shaped URLs first, so a tight page budget spends itself on what matters. */
export function prioritize(urls: string[]): string[] {
	return urls.toSorted((a, b) => Number(MENU_HINT.test(b)) - Number(MENU_HINT.test(a)));
}

async function settle(page: Page, extraWaitMs: number): Promise<void> {
	await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
	// nudge lazy-loaded sections (common on restaurant sites)
	await page
		.evaluate(async () => {
			for (let y = 0; y < document.body.scrollHeight; y += 800) {
				window.scrollTo(0, y);
				await new Promise((r) => setTimeout(r, 100));
			}
			window.scrollTo(0, 0);
		})
		.catch(() => {});
	await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
	await page.waitForTimeout(extraWaitMs);
}

function attachRecorder(context: BrowserContext, store: SnapshotStore, warnings: string[]): void {
	context.on('response', (response) => {
		void (async () => {
			const req = response.request();
			const status = response.status();
			let body: Uint8Array | undefined;
			try {
				body = new Uint8Array(await response.body());
			} catch {
				// 3xx / 204 / aborted — no body available, record the exchange anyway
			}
			const headers = await response.allHeaders().catch(() => ({}) as Record<string, string>);
			try {
				store.put({
					method: req.method(),
					url: response.url(),
					requestBody: req.postData() ?? undefined,
					status,
					contentType: headers['content-type'] ?? null,
					location: headers['location'],
					body
				});
			} catch (e) {
				warnings.push(`failed to record ${response.url()}: ${String(e)}`);
			}
		})();
	});
}

async function recordPdf(
	context: BrowserContext,
	store: SnapshotStore,
	url: string
): Promise<void> {
	const res = await context.request.get(url, { timeout: 30_000 });
	store.put({
		method: 'GET',
		url,
		status: res.status(),
		contentType: res.headers()['content-type'] ?? null,
		body: new Uint8Array(await res.body())
	});
}

export async function record(opts: {
	taskDir: string;
	entryUrl: string;
	extraUrls: string[];
	maxPages: number;
	maxDepth: number;
	waitMs: number;
	headed: boolean;
}): Promise<BenchManifest> {
	const store = new SnapshotStore(join(opts.taskDir, 'snapshot'));
	const entry = normalizeUrl(opts.entryUrl);
	const primaryHost = new URL(entry).host.toLowerCase();
	const prior = loadManifest(opts.taskDir);
	if (prior && prior.primaryHost !== primaryHost) {
		throw new Error(
			`task already snapshots ${prior.primaryHost}; refusing to mix in ${primaryHost}`
		);
	}
	const warnings: string[] = [];
	const pages: BenchManifest['pages'] = prior?.pages ?? [];
	const pageByUrl = new Map(pages.map((p) => [p.url, p]));

	const browser = await chromium.launch({
		executablePath: findChromium(),
		headless: !opts.headed
	});
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	attachRecorder(context, store, warnings);
	const page = await context.newPage();

	const queue: { url: string; depth: number }[] = [
		{ url: entry, depth: 0 },
		...opts.extraUrls.map((u) => ({ url: normalizeUrl(u), depth: 0 }))
	];
	const visited = new Set<string>();
	let navigations = 0;

	let next: { url: string; depth: number } | undefined;
	while (navigations < opts.maxPages && (next = queue.shift())) {
		const { url, depth } = next;
		if (visited.has(url)) continue;
		visited.add(url);

		if (/\.pdf(\?|$)/i.test(url)) {
			try {
				await recordPdf(context, store, url);
				console.error(`  pdf  ${url}`);
			} catch (e) {
				warnings.push(`pdf fetch failed: ${url}: ${String(e)}`);
			}
			continue;
		}

		navigations++;
		let status = 0;
		try {
			const res = await page.goto(url, { timeout: 30_000, waitUntil: 'domcontentloaded' });
			status = res?.status() ?? 0;
			await settle(page, opts.waitMs);
		} catch (e) {
			warnings.push(`navigation failed: ${url}: ${String(e)}`);
			console.error(`  FAIL ${url}`);
			continue;
		}

		const title = await page.title().catch(() => '');
		const html = await page.content().catch(() => '');
		store.putRendered(url, html);
		const info = { url, status, title, depth };
		const existing = pageByUrl.get(url);
		if (existing) Object.assign(existing, info);
		else {
			pages.push(info);
			pageByUrl.set(url, info);
		}
		console.error(`  ${String(status).padEnd(4)} ${url}  (${title})`);

		const visibleText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
		if (looksLikeBotWall(status, title, visibleText)) {
			warnings.push(`possible bot-wall at ${url} (status ${status})`);
		}

		if (depth < opts.maxDepth) {
			const hrefs = await page
				.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href') ?? ''))
				.catch(() => [] as string[]);
			const links = prioritize(extractLinks(hrefs, page.url(), primaryHost)).filter(
				(l) => !visited.has(l)
			);
			for (const l of links) queue.push({ url: l, depth: depth + 1 });
			// keep menu-shaped URLs at the front across the whole frontier
			queue.sort(
				(a, b) => Number(MENU_HINT.test(b.url)) - Number(MENU_HINT.test(a.url)) || a.depth - b.depth
			);
		}
	}
	if (queue.length > 0) {
		warnings.push(`page budget exhausted with ${queue.length} URLs unvisited (raise --max-pages)`);
	}

	await browser.close();
	store.save();

	const manifest: BenchManifest = {
		entryUrl: entry,
		primaryHost,
		createdAt: prior?.createdAt ?? new Date().toISOString(),
		lastRecordedAt: new Date().toISOString(),
		pages,
		// prior warnings about URLs re-visited this run are stale — this run re-judged them
		warnings: [
			...new Set([
				...(prior?.warnings ?? []).filter(
					(w) => !w.startsWith('page budget exhausted') && ![...visited].some((u) => w.includes(u))
				),
				...warnings
			])
		],
		counts: {
			pages: pages.length,
			responses: store.index.entries.length,
			hosts: store.hosts().length
		}
	};
	saveManifest(opts.taskDir, manifest);
	return manifest;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const positional: string[] = [];
	const extraUrls: string[] = [];
	let maxPages = 40;
	let maxDepth = 4;
	let waitMs = 1500;
	let headed = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--url') extraUrls.push(args[++i]);
		else if (a === '--max-pages') maxPages = Number(args[++i]);
		else if (a === '--max-depth') maxDepth = Number(args[++i]);
		else if (a === '--wait') waitMs = Number(args[++i]);
		else if (a === '--headed') headed = true;
		else positional.push(a);
	}
	const [taskDir, entryUrl] = positional;
	if (!taskDir || !entryUrl) {
		console.error(
			'usage: bun run bench:record <task-dir> <entry-url> [--url u]* [--max-pages n] [--max-depth n] [--wait ms] [--headed]'
		);
		process.exit(1);
	}
	const manifest = await record({
		taskDir,
		entryUrl,
		extraUrls,
		maxPages,
		maxDepth,
		waitMs,
		headed
	});
	console.error(
		`\nrecorded ${manifest.counts.responses} responses across ${manifest.counts.hosts} hosts; ${manifest.counts.pages} pages rendered`
	);
	for (const w of manifest.warnings) console.error(`  warning: ${w}`);
}
