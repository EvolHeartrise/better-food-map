/// <reference types="bun-types" />
// Exercises the gate's SQL against the real migration schema (freshDb applies
// every migration, including 0029) — ordering, filters, and the persistence
// contract (baseline hashes never touched by a check sweep).
import { test, expect } from 'bun:test';
import { freshDb } from '../test-d1';
import {
	replaceWatchRows,
	staleMenus,
	stampLastChecked,
	touchStableRows,
	watchRowsFor,
	type BaselineRow
} from './db';

async function seedMenu(
	db: ReturnType<typeof freshDb>,
	id: string,
	opts: { verified?: string | null; checked?: string; items?: number; openLocations?: number } = {}
) {
	const { verified = '2026-01-01', checked, items = 1, openLocations = 1 } = opts;
	// 0012's triggers forbid inserting/blanking an empty last_verified, so the
	// "never verified" case (prod rows predating 0012) is modeled as a far-past
	// date here — same position in the staleness ordering.
	await db
		.prepare(`INSERT INTO menus (id, name, last_verified, last_checked) VALUES (?, ?, ?, ?)`)
		.bind(id, `Menu ${id}`, verified ?? '1970-01-01', checked ?? null)
		.run();
	for (let i = 0; i < items; i++) {
		await db
			.prepare(`INSERT INTO items (id, menu_id, item_name) VALUES (?, ?, ?)`)
			.bind(`${id}-item-${i}`, id, `Dish ${i}`)
			.run();
	}
	for (let i = 0; i < openLocations; i++) {
		await db
			.prepare(
				`INSERT INTO locations (id, name, latitude, longitude, menu_id, street, city, region, country)
				 VALUES (?, ?, 49.2, -123.1, ?, '1 Test St', 'Vancouver', 'BC', 'CA')`
			)
			.bind(`${id}-loc-${i}`, `Venue ${id}`, id)
			.run();
	}
}

function row(url: string, over: Partial<BaselineRow> = {}): BaselineRow {
	return {
		url,
		kind: 'html',
		content_hash: 'text:aaa',
		signal_hash: null,
		etag: null,
		last_modified: null,
		fetch_status: 'ok',
		...over
	};
}

test('staleMenus: stalest-first ordering, empty/closed menus excluded, private menus included', async () => {
	const db = freshDb();
	await seedMenu(db, 'm-old', { verified: '2026-01-01' });
	await seedMenu(db, 'm-new', { verified: '2026-07-01', checked: '2026-07-10' });
	await seedMenu(db, 'm-ancient', { verified: '1970-01-01' });
	await seedMenu(db, 'm-empty', { verified: '2025-01-01', items: 0 });
	await seedMenu(db, 'm-no-locations', { verified: '2025-01-01', openLocations: 0 });
	// a menu whose only location is closed has no live footprint
	await seedMenu(db, 'm-closed-loc', { verified: '2025-01-01' });
	await db
		.prepare(`UPDATE locations SET closed_at = 1700000000000 WHERE menu_id = ?`)
		.bind('m-closed-loc')
		.run();

	const menus = await staleMenus(db, 10);
	expect(menus.map((m) => m.menu_id)).toEqual(['m-ancient', 'm-old', 'm-new']);
	const mNew = menus.find((m) => m.menu_id === 'm-new');
	expect(mNew?.last_checked).toBe('2026-07-10');
	expect(mNew?.item_count).toBe(1);
	expect(mNew?.location_count).toBe(1);
	// private venue menus (brand_id null) are in scope — unlike list_menus
	expect(menus.every((m) => m.brand_id === null)).toBe(true);
	// LIMIT applies
	expect((await staleMenus(db, 2)).map((m) => m.menu_id)).toEqual(['m-ancient', 'm-old']);
});

test('watchRowsFor groups rows per menu; replaceWatchRows replaces wholesale', async () => {
	const db = freshDb();
	await seedMenu(db, 'm1');
	await seedMenu(db, 'm2');
	await replaceWatchRows(
		db,
		'm1',
		[row('https://a.example/menu'), row('https://a.example/drinks')],
		'2026-07-18'
	);
	await replaceWatchRows(
		db,
		'm2',
		[row('https://b.example/menu', { kind: 'feed', content_hash: 'feed:bbb' })],
		'2026-07-18'
	);

	const map = await watchRowsFor(db, ['m1', 'm2', 'm-none']);
	expect(map.get('m1')?.map((r) => r.url)).toEqual([
		'https://a.example/drinks',
		'https://a.example/menu'
	]);
	expect(map.get('m2')?.[0]?.kind).toBe('feed');
	expect(map.has('m-none')).toBe(false);
	expect((await watchRowsFor(db, [])).size).toBe(0);

	// a re-baseline REPLACES the old set, dropped urls don't linger
	await replaceWatchRows(db, 'm1', [row('https://a.example/new-menu')], '2026-07-19');
	expect((await watchRowsFor(db, ['m1'])).get('m1')?.map((r) => r.url)).toEqual([
		'https://a.example/new-menu'
	]);
});

test('touchStableRows advances checked_at/validators but never baseline hashes', async () => {
	const db = freshDb();
	await seedMenu(db, 'm1');
	await replaceWatchRows(
		db,
		'm1',
		[row('https://a.example/menu', { etag: 'W/"old"' }), row('https://a.example/drinks')],
		'2026-07-01'
	);
	await touchStableRows(
		db,
		'm1',
		[
			{
				url: 'https://a.example/menu',
				fetch_status: 'ok',
				content_hash: 'text:IGNORED',
				signal_hash: null,
				etag: 'W/"new"',
				last_modified: 'Sat, 18 Jul 2026 00:00:00 GMT'
			}
		],
		'2026-07-18'
	);
	const all = await db
		.prepare(
			`SELECT url, content_hash, etag, checked_at FROM menu_watch_urls WHERE menu_id = ? ORDER BY url`
		)
		.bind('m1')
		.all<{ url: string; content_hash: string; etag: string | null; checked_at: string }>();
	const [drinks, menu] = all.results;
	expect(menu.etag).toBe('W/"new"');
	expect(menu.checked_at).toBe('2026-07-18');
	expect(menu.content_hash).toBe('text:aaa'); // baseline hash untouched
	expect(drinks.checked_at).toBe('2026-07-01'); // untouched row unmoved
	// no-op call is fine
	await touchStableRows(db, 'm1', [], '2026-07-19');
});

test('stampLastChecked writes menus.last_checked without touching last_verified', async () => {
	const db = freshDb();
	await seedMenu(db, 'm1', { verified: '2026-01-01' });
	await stampLastChecked(db, 'm1', '2026-07-18');
	const m = await db
		.prepare(`SELECT last_verified, last_checked FROM menus WHERE id = ?`)
		.bind('m1')
		.first<{ last_verified: string; last_checked: string }>();
	expect(m?.last_checked).toBe('2026-07-18');
	expect(m?.last_verified).toBe('2026-01-01');
});
