import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCorpus } from './lint';
import {
	checkPromote,
	orderedPages,
	parseCli,
	perItemHits,
	readablePageText,
	resolveReviewFile,
	validateSave
} from './review';
import { SnapshotStore } from './snapshot-store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A temp task dir with a SnapshotStore under <task>/snapshot, cleaned up after. */
function withTask(fn: (task: { dir: string; store: SnapshotStore }) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'bench-review-'));
	try {
		fn({ dir, store: new SnapshotStore(join(dir, 'snapshot')) });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function recordPage(store: SnapshotStore, url: string, html: string): void {
	store.put({ method: 'GET', url, status: 200, contentType: 'text/html', body: enc(html) });
}

function writeGold(dir: string, file: 'draft' | 'data', content: unknown): void {
	mkdirSync(join(dir, 'gold'), { recursive: true });
	writeFileSync(join(dir, 'gold', `${file}.json`), JSON.stringify(content, null, '\t') + '\n');
}

const GOOD_ITEMS = [
	{
		name: 'Samosa',
		description: null,
		tags: ['vegan'],
		optional_tags: [],
		price: 3.99,
		warning: null
	}
];

describe('resolveReviewFile', () => {
	test('prefers draft over data by default, exits (error) when neither exists', () => {
		withTask(({ dir }) => {
			expect(resolveReviewFile(dir).ok).toBe(false);

			writeGold(dir, 'data', {
				policy_version: 'x',
				sources: ['https://x.com/'],
				items: GOOD_ITEMS
			});
			const dataOnly = resolveReviewFile(dir);
			expect(dataOnly).toMatchObject({ ok: true, file: 'data' });

			writeGold(dir, 'draft', {
				policy_version: 'draft',
				sources: ['https://x.com/'],
				items: GOOD_ITEMS
			});
			const both = resolveReviewFile(dir);
			expect(both).toMatchObject({ ok: true, file: 'draft' });
		});
	});

	test('explicit --file requires that file to exist', () => {
		withTask(({ dir }) => {
			writeGold(dir, 'draft', {
				policy_version: 'draft',
				sources: ['https://x.com/'],
				items: GOOD_ITEMS
			});
			expect(resolveReviewFile(dir, 'data').ok).toBe(false);
			expect(resolveReviewFile(dir, 'draft')).toMatchObject({ ok: true, file: 'draft' });
		});
	});
});

describe('parseCli', () => {
	test('defaults port 8790, accepts --port and --file', () => {
		expect(parseCli(['bench/tasks/x'])).toEqual({
			taskDir: 'bench/tasks/x',
			port: 8790,
			file: undefined
		});
		expect(parseCli(['t', '--port', '9000', '--file', 'data'])).toEqual({
			taskDir: 't',
			port: 9000,
			file: 'data'
		});
	});
	test('rejects a bad --file and a missing task dir', () => {
		expect(parseCli(['t', '--file', 'gold'])).toHaveProperty('error');
		expect(parseCli([])).toHaveProperty('error');
	});
});

describe('perItemHits / state assembly', () => {
	test('flags a zero-hit name and passes a found one', () => {
		withTask(({ store }) => {
			recordPage(store, 'https://x.com/menu', '<h1>Samosa</h1><p>fresh in-house daily</p>');
			const corpus = buildCorpus(store);
			const hits = perItemHits(
				[
					{ name: 'Samosa', description: 'fresh in-house daily' },
					{ name: 'Phantom Dish', description: null }
				],
				corpus
			);
			expect(hits[0]).toEqual({ nameFound: true, descFound: true });
			expect(hits[1].nameFound).toBe(false);
		});
	});

	test('a variant name finds its base; a rewritten base does not', () => {
		withTask(({ store }) => {
			recordPage(store, 'https://x.com/menu', '<h1>Fresh Soup!</h1><p>Fries</p>');
			const corpus = buildCorpus(store);
			const hits = perItemHits(
				[
					{ name: 'Fresh Soup! (bowl)', description: null },
					{ name: 'Creamy Bisque (bowl)', description: null }
				],
				corpus
			);
			expect(hits[0].nameFound).toBe(true);
			expect(hits[1].nameFound).toBe(false);
		});
	});
});

describe('validateSave', () => {
	test('rejects an invalid item (bad tag) with issues', () => {
		const bad = validateSave({
			items: [{ name: 'X', description: null, tags: ['spicy'], optional_tags: [], price: 1 }]
		});
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.issues.join()).toMatch(/tags/);
	});
	test('accepts a valid item set', () => {
		const ok = validateSave({
			items: GOOD_ITEMS,
			sources: ['https://x.com/menu'],
			reviewed: ['Samosa']
		});
		expect(ok.ok).toBe(true);
	});
});

describe('checkPromote', () => {
	test('refuses while a zero-hit name exists, succeeds once names are found', () => {
		withTask(({ store }) => {
			recordPage(store, 'https://x.com/menu', '<h1>Samosa</h1>');
			const corpus = buildCorpus(store);
			const recordedUrls = new Set(
				store.index.entries.filter((e) => e.method === 'GET').map((e) => e.url)
			);

			const bad = checkPromote(
				{
					sources: ['https://x.com/menu'],
					items: [
						{ name: 'Phantom Dish', description: null, tags: [], optional_tags: [], price: null }
					]
				},
				'2026-08-01',
				corpus,
				recordedUrls
			);
			expect(bad.errors.length).toBeGreaterThan(0);

			const good = checkPromote(
				{
					sources: ['https://x.com/menu'],
					items: [{ name: 'Samosa', description: null, tags: [], optional_tags: [], price: null }]
				},
				'2026-08-01',
				corpus,
				recordedUrls
			);
			expect(good.errors).toEqual([]);
		});
	});
});

describe('readablePageText / orderedPages', () => {
	test('block tags become line breaks, inline whitespace collapses', () => {
		withTask(({ store }) => {
			recordPage(
				store,
				'https://x.com/menu',
				'<h1>Menu</h1><ul><li>Samosa   $6</li><li>Chai</li></ul>'
			);
			const text = readablePageText(store, 'https://x.com/menu');
			expect(text.split('\n')).toEqual(['Menu', 'Samosa $6', 'Chai']);
			expect(readablePageText(store, 'https://x.com/missing')).toBe('');
		});
	});
	test('menu-shaped pages sort first, ties stable', () => {
		const ordered = orderedPages({
			entryUrl: 'https://x.com/',
			primaryHost: 'x.com',
			createdAt: '',
			lastRecordedAt: '',
			warnings: [],
			counts: { pages: 0, responses: 0, hosts: 0 },
			pages: [
				{ url: 'https://x.com/about', status: 200, title: 'About', depth: 1 },
				{ url: 'https://x.com/drink-menu', status: 200, title: 'Drinks', depth: 1 },
				{ url: 'https://x.com/contact', status: 200, title: 'Contact', depth: 1 }
			]
		});
		expect(ordered[0].url).toBe('https://x.com/drink-menu');
		expect(ordered.map((p) => p.title)).toEqual(['Drinks', 'About', 'Contact']);
	});
});

// --- optional real-data smoke test (bench/ is gitignored; skips when absent) ---
const REAL = join('bench', 'tasks', 'meetonmain');
const hasReal =
	existsSync(join(REAL, 'gold', 'draft.json')) && existsSync(join(REAL, 'manifest.json'));

describe.skipIf(!hasReal)('real meetonmain data', () => {
	test('perItemHits finds real zero-hit names in the drafted gold', () => {
		const store = new SnapshotStore(join(REAL, 'snapshot'));
		const corpus = buildCorpus(store);
		const draft = JSON.parse(readFileSync(join(REAL, 'gold', 'draft.json'), 'utf-8')) as {
			items: { name: string; description: string | null }[];
		};
		const hits = perItemHits(draft.items, corpus);
		const zero = hits.filter((h) => !h.nameFound).length;
		expect(draft.items.length).toBeGreaterThan(100);
		// the draft's known failure mode: many rewritten names miss the snapshot
		expect(zero).toBeGreaterThan(0);
	});
});
