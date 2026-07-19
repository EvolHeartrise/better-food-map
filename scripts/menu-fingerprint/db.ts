// D1 access for the menu-source change gate (check.ts / baseline.ts), over the
// same HTTP-backed client the MCP server uses. Runs OUTSIDE the Worker, against
// production D1 — credentials come from .env (bun auto-loads it).
//
// Persistence contract, shared with decide.ts:
//   • menu_watch_urls rows are BASELINE state: hashes + fetch_status describe
//     what baseline.ts saw right after an agent refresh. A check sweep never
//     overwrites a baseline hash or its fetch_status — a changed/failed row
//     routes the menu to the agent path, and the post-refresh baseline rewrite
//     is what re-baselines it. Only STABLE rows get their checked_at and HTTP
//     validators advanced (persisting a new etag on a CHANGED row would make
//     the next conditional GET 304 against content we never accepted).
//   • menus.last_checked is stamped only when a whole menu decided 'unchanged'.

import { createHttpD1 } from '../../src/lib/server/d1-http';
import type { D1Like } from '../../src/lib/server/db';
import type { FetchOutcome, FetchStatus, WatchKind, WatchRow } from './decide';

export function openDb(): D1Like {
	return createHttpD1();
}

/** The row shape the menu-refresh workflow's `menus` arg expects, plus gate fields. */
export interface StaleMenu {
	menu_id: string;
	menu_name: string;
	brand_id: string | null;
	last_verified: string | null;
	last_checked: string | null;
	item_count: number;
	location_count: number;
}

/**
 * Menus in refresh-priority order: never-verified first, then last_verified
 * ascending. Matches the workflow's selection semantics (open locations only,
 * non-empty menus) but — unlike list_menus — includes private venue menus,
 * which the workflow can refresh when handed to it explicitly.
 */
export async function staleMenus(db: D1Like, scan: number): Promise<StaleMenu[]> {
	// Aliases are not visible in WHERE, hence the wrapping subselect.
	const { results } = await db
		.prepare(
			`SELECT * FROM (
				SELECT m.id AS menu_id, m.name AS menu_name, m.brand_id, m.last_verified, m.last_checked,
					(SELECT COUNT(*) FROM items i WHERE i.menu_id = m.id) AS item_count,
					(SELECT COUNT(*) FROM locations l WHERE l.menu_id = m.id AND l.closed_at IS NULL)
						AS location_count
				FROM menus m
			 )
			 WHERE item_count > 0 AND location_count > 0
			 ORDER BY (last_verified IS NOT NULL), last_verified ASC
			 LIMIT ?`
		)
		.bind(scan)
		.all<StaleMenu>();
	return results;
}

export async function watchRowsFor(
	db: D1Like,
	menuIds: string[]
): Promise<Map<string, WatchRow[]>> {
	const map = new Map<string, WatchRow[]>();
	if (menuIds.length === 0) return map;
	const placeholders = menuIds.map(() => '?').join(',');
	const { results } = await db
		.prepare(
			`SELECT menu_id, url, kind, content_hash, signal_hash, etag, last_modified, fetch_status
			 FROM menu_watch_urls WHERE menu_id IN (${placeholders}) ORDER BY menu_id, url`
		)
		.bind(...menuIds)
		.all<WatchRow & { menu_id: string }>();
	for (const row of results) {
		const { menu_id, ...watch } = row;
		const list = map.get(menu_id);
		if (list) list.push(watch);
		else map.set(menu_id, [watch]);
	}
	return map;
}

/** Advance checked_at + HTTP validators on rows that compared STABLE (see contract above). */
export async function touchStableRows(
	db: D1Like,
	menuId: string,
	outcomes: FetchOutcome[],
	checkedAt: string
): Promise<void> {
	if (outcomes.length === 0) return;
	const statements = outcomes.map((o) =>
		db
			.prepare(
				`UPDATE menu_watch_urls SET checked_at = ?, etag = ?, last_modified = ?
				 WHERE menu_id = ? AND url = ?`
			)
			.bind(checkedAt, o.etag, o.last_modified, menuId, o.url)
	);
	await db.batch(statements);
}

export async function stampLastChecked(db: D1Like, menuId: string, date: string): Promise<void> {
	await db.prepare(`UPDATE menus SET last_checked = ? WHERE id = ?`).bind(date, menuId).run();
}

export interface BaselineRow {
	url: string;
	kind: WatchKind;
	content_hash: string | null;
	signal_hash: string | null;
	etag: string | null;
	last_modified: string | null;
	fetch_status: FetchStatus;
}

/** Atomically replace a menu's watch set — the baseline defines it wholesale. */
export async function replaceWatchRows(
	db: D1Like,
	menuId: string,
	rows: BaselineRow[],
	checkedAt: string
): Promise<void> {
	const statements = [
		db.prepare(`DELETE FROM menu_watch_urls WHERE menu_id = ?`).bind(menuId),
		...rows.map((r) =>
			db
				.prepare(
					`INSERT INTO menu_watch_urls
						(menu_id, url, kind, content_hash, signal_hash, etag, last_modified, checked_at, fetch_status)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					menuId,
					r.url,
					r.kind,
					r.content_hash,
					r.signal_hash,
					r.etag,
					r.last_modified,
					checkedAt,
					r.fetch_status
				)
		)
	];
	await db.batch(statements);
}

export interface MenuMeta {
	id: string;
	name: string;
	refresh_notes: string | null;
	source_urls: string[];
}

export async function menuMeta(db: D1Like, menuId: string): Promise<MenuMeta | null> {
	const [row, { results: sources }] = await Promise.all([
		db
			.prepare(`SELECT id, name, refresh_notes FROM menus WHERE id = ?`)
			.bind(menuId)
			.first<{ id: string; name: string; refresh_notes: string | null }>(),
		db
			.prepare(`SELECT url FROM menu_sources WHERE menu_id = ? ORDER BY rowid`)
			.bind(menuId)
			.all<{ url: string }>()
	]);
	if (!row) return null;
	return { ...row, source_urls: sources.map((s) => s.url) };
}
