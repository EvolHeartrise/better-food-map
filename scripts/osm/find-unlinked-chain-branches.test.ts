import { test, expect } from 'bun:test';
import { findUnlinkedChainBranches } from './find-unlinked-chain-branches';
import {
	insertLocations,
	insertBrand,
	insertMenu,
	insertMenuItems
} from '../../src/lib/server/db-write';
import { freshDb } from '../test-d1';

/** A minimal location insert; override per test. */
function loc(over: Record<string, unknown> = {}) {
	return {
		name: 'Venue',
		category: 'fast_food' as const,
		latitude: 49.28,
		longitude: -123.12,
		street: '1 Test St',
		city: 'Vancouver',
		region: 'BC',
		postcode: 'V6J 1M5',
		country: 'CA',
		phone: null,
		website: null,
		...over
	};
}

test('flags an independent venue whose name matches a chain, with its stale menu size', async () => {
	const db = freshDb();
	await insertBrand(db, { name: 'A&W', website: null, logo_url: null });
	// The stray: an INDEPENDENT venue (no brand_id) named "A&W" on a private menu.
	await insertLocations(db, [
		loc({
			name: 'A&W',
			street: '12133 72 Ave',
			items: [
				{ item_name: 'Mama Burger', price: 6.49 },
				{ item_name: 'Root Beer', price: 2.59 }
			]
		})
	]);

	const res = await findUnlinkedChainBranches(db);
	expect(res.total).toBe(1);
	expect(res.unlinked.length).toBe(1);
	const [flag] = res.unlinked;
	expect(flag.name).toBe('A&W');
	expect(flag.brand.name).toBe('A&W');
	expect(flag.address).toBe('12133 72 Ave, Vancouver, BC V6J 1M5');
	expect(flag.item_count).toBe(2);
	expect(res.additional).toBe(0);
});

test('a properly-linked chain branch is NOT flagged', async () => {
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'A&W', website: null, logo_url: null });
	const menuId = await insertMenu(db, { brand_id: brandId, name: 'A&W Canada' });
	await insertMenuItems(db, [{ menu_id: menuId, item_name: 'Teen Burger' }]);
	await insertLocations(db, [loc({ name: 'A&W', brand_id: brandId, menu_id: menuId })]);

	const res = await findUnlinkedChainBranches(db);
	expect(res.total).toBe(0);
	expect(res.unlinked).toEqual([]);
});

test('an independent venue matching no chain is NOT flagged', async () => {
	const db = freshDb();
	await insertBrand(db, { name: 'A&W', website: null, logo_url: null });
	await insertLocations(db, [loc({ name: 'Pizza Palace', items: [{ item_name: 'Margherita' }] })]);

	const res = await findUnlinkedChainBranches(db);
	expect(res.total).toBe(0);
});

test('a closed independent lookalike is NOT flagged (only open venues need adopting)', async () => {
	const db = freshDb();
	await insertBrand(db, { name: 'A&W', website: null, logo_url: null });
	const [venue] = await insertLocations(db, [
		loc({ name: 'A&W', items: [{ item_name: 'Fries' }] })
	]);
	await db.prepare(`UPDATE locations SET closed_at = '2026-01-01' WHERE id = ?`).bind(venue).run();

	const res = await findUnlinkedChainBranches(db);
	expect(res.total).toBe(0);
});

test('matches name variants the way import_chain dedup does (containment)', async () => {
	const db = freshDb();
	await insertBrand(db, { name: "McDonald's", website: null, logo_url: null });
	// "McDonald's Restaurant" ⊃ "mcdonalds" (normalized) → a namesMatch containment hit.
	await insertLocations(db, [
		loc({ name: "McDonald's Restaurant", items: [{ item_name: 'Big Mac' }] })
	]);

	const res = await findUnlinkedChainBranches(db);
	expect(res.total).toBe(1);
	expect(res.unlinked[0].brand.name).toBe("McDonald's");
});

test('limit caps the returned list and counts the rest in additional', async () => {
	const db = freshDb();
	await insertBrand(db, { name: 'A&W', website: null, logo_url: null });
	await insertLocations(db, [
		loc({ name: 'A&W', street: '1 A St', items: [{ item_name: 'x' }] }),
		loc({ name: 'A&W', street: '2 B St', items: [{ item_name: 'y' }] }),
		loc({ name: 'A&W', street: '3 C St', items: [{ item_name: 'z' }] })
	]);

	const res = await findUnlinkedChainBranches(db, { limit: 2 });
	expect(res.total).toBe(3);
	expect(res.returned).toBe(2);
	expect(res.additional).toBe(1);
});

test('a dismissal pins the matched brand — matching a different chain re-flags', async () => {
	const { splitDismissKey } = await import('./audit-dismiss');
	const db = freshDb();
	const brandId = await insertBrand(db, { name: 'A&W', website: null, logo_url: null });
	const [venue] = await insertLocations(db, [loc({ name: 'A&W', brand_id: null })]);

	const first = await findUnlinkedChainBranches(db);
	expect(first.unlinked.length).toBe(1);
	expect(first.unlinked[0].dismiss_key).toBe(`${venue}#${brandId}`);

	const { subject, fingerprint } = splitDismissKey(first.unlinked[0].dismiss_key)!;
	const dismissals = new Map([
		[subject, { fingerprint, reason: 'unaffiliated namesake', dismissed_at: '2026-07-09' }]
	]);
	const suppressed = await findUnlinkedChainBranches(db, { dismissals });
	expect(suppressed.unlinked.length).toBe(0);
	expect(suppressed.suppressed_dismissed).toBe(1);

	// A dismissal recorded against a DIFFERENT brand id does not suppress.
	const stale = new Map([
		[subject, { fingerprint: 'some-other-brand', reason: 'x', dismissed_at: '2026-07-09' }]
	]);
	const reflagged = await findUnlinkedChainBranches(db, { dismissals: stale });
	expect(reflagged.unlinked.length).toBe(1);
	expect(reflagged.suppressed_dismissed).toBe(0);
});
