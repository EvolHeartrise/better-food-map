import { test, expect } from 'bun:test';
import { DismissFilter, dismissKey, fnv1a, splitDismissKey } from './audit-dismiss';
import { namesMatchCosmetic } from './find-identity-drift';

test('dismissKey and splitDismissKey round-trip, splitting at the FIRST "#"', () => {
	expect(dismissKey('loc-1', 'renamed:cafebel')).toBe('loc-1#renamed:cafebel');
	expect(splitDismissKey('loc-1#renamed:cafebel')).toEqual({
		subject: 'loc-1',
		fingerprint: 'renamed:cafebel'
	});
	// Empty fingerprint (duplicate pairs) still round-trips.
	expect(splitDismissKey('a|b#')).toEqual({ subject: 'a|b', fingerprint: '' });
	// A fingerprint containing '#' stays intact.
	expect(splitDismissKey('id#a#b')).toEqual({ subject: 'id', fingerprint: 'a#b' });
	// No separator, or nothing before it → not a key.
	expect(splitDismissKey('no-separator')).toBeNull();
	expect(splitDismissKey('#fingerprint-only')).toBeNull();
});

test('fnv1a is a stable 8-hex-char content hash', () => {
	expect(fnv1a('Bacon &amp; Egg')).toMatch(/^[0-9a-f]{8}$/);
	expect(fnv1a('Bacon &amp; Egg')).toBe(fnv1a('Bacon &amp; Egg'));
	expect(fnv1a('Bacon &amp; Egg')).not.toBe(fnv1a('Bacon & Egg'));
	expect(fnv1a('')).toMatch(/^[0-9a-f]{8}$/);
});

test('DismissFilter drops on fingerprint match, keeps on mismatch, counts both modes', () => {
	const record = { fingerprint: 'vanished', reason: 'verified open', dismissed_at: '2026-07-09' };
	const drop = new DismissFilter({ dismissals: new Map([['L1', record]]) });

	// Match → dropped and counted; dismiss_key still composed for the caller.
	const matched = drop.evaluate('L1', 'vanished');
	expect(matched.drop).toBe(true);
	expect(matched.fields.dismiss_key).toBe('L1#vanished');
	expect(drop.suppressed).toBe(1);

	// Same subject, different evidence → kept, unannotated, not counted.
	const stale = drop.evaluate('L1', 'renamed:newname');
	expect(stale.drop).toBe(false);
	expect(stale.fields.dismissed).toBeUndefined();
	expect(drop.suppressed).toBe(1);

	// Unknown subject → kept.
	expect(drop.evaluate('L2', 'vanished').drop).toBe(false);

	// include_dismissed: matched findings are kept but annotated, still counted.
	const keep = new DismissFilter({
		dismissals: new Map([['L1', record]]),
		include_dismissed: true
	});
	const surfaced = keep.evaluate('L1', 'vanished');
	expect(surfaced.drop).toBe(false);
	expect(surfaced.fields.dismissed).toEqual({
		reason: 'verified open',
		dismissed_at: '2026-07-09'
	});
	expect(keep.suppressed).toBe(1);
});

test('namesMatchCosmetic folds respellings and word-order flips, not different venues', () => {
	// Word-order flip with diacritics.
	expect(namesMatchCosmetic('Bel Café', 'Cafe Bel')).toBe(true);
	// Doubled-letter/diacritic respelling (edit distance 1 on collapsed names).
	expect(namesMatchCosmetic('Caffè Artigiano', 'Cafe Artigiano')).toBe(true);
	expect(namesMatchCosmetic('Café Artigiano', 'Caffè Artigiano')).toBe(true);
	// The dedup rule (containment) still folds.
	expect(namesMatchCosmetic('Joe Coffee', 'Joe Coffee Roasters')).toBe(true);
	// '&' folding.
	expect(namesMatchCosmetic('Fish & Chips Co', 'Fish and Chips Co')).toBe(true);

	// Different venues stay distinct.
	expect(namesMatchCosmetic('Tim Hortons', 'Starbucks')).toBe(false);
	// Brand rebrand with a NEW word is a real signal, not cosmetic.
	expect(namesMatchCosmetic("Mary Brown's", 'Mary Brown Chicken')).toBe(false);
	expect(namesMatchCosmetic('OPA! of Greece', 'Opa!')).toBe(false);
	// Short names never get an edit-distance budget.
	expect(namesMatchCosmetic('Pho 99', 'Pho 88')).toBe(false);
	expect(namesMatchCosmetic('', 'Starbucks')).toBe(false);

	// Digit changes NEVER fold, whatever the length — a renumbering is the
	// classic new-owner tell ("Pho 99" → "Pho 88" at the same address).
	expect(namesMatchCosmetic('Pho 99 Vietnamese', 'Pho 88 Vietnamese')).toBe(false);
	expect(namesMatchCosmetic('Restaurant 62 Bistro', 'Restaurant 63 Bistro')).toBe(false);
	// Same digits + tiny respelling still folds.
	expect(namesMatchCosmetic('Cafe 21 Espresso', 'Caffe 21 Espresso')).toBe(true);
});
