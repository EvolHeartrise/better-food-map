/**
 * Wire-shape contract for `page_coverage`.
 *
 * Most of `types.ts` hand-mirrors the server's payloads across the JSON
 * boundary, and nothing makes the compiler check a mirror against the thing it
 * reflects: a server field can be deleted while the SPA keeps reading it, and
 * both sides type-check because each is internally consistent.
 *
 * That is not hypothetical. `pageCoverage` dropped `menu_available`,
 * `menu_visited`, `menu_ratio` and `menu_unvisited` when the menu-page ratio was
 * removed as unsound, but `RunDetail.svelte` and `types.ts` kept them. The
 * navigation tab then crashed on EVERY run — "can't access property length,
 * page_coverage.menu_unvisited is undefined" — and shipped, because the module's
 * own test (`expect(coverage).not.toHaveProperty('menu_ratio')`) passed happily
 * while its only consumer was broken. Nothing connected the two.
 *
 * `types.ts` now IMPORTS `PageCoverage` instead of restating it, which makes
 * that particular drift a compile error. These tests cover what the type system
 * still cannot see: that the values actually arrive, and in the shape the UI
 * length-checks.
 */
import { describe, expect, test } from 'bun:test';
import { pageCoverage, type PageCoverage } from '../../../scripts/bench/analyze/transcript';
import type { RunDetail } from './types';

/**
 * The client's declared shape and the server's must be the SAME type, not merely
 * compatible ones. Both directions are asserted: a server field the client lacks
 * fails the first, a client field the server lacks fails the second.
 */
type Declared = NonNullable<RunDetail['page_coverage']>;
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _sameType: AssertEqual<Declared, PageCoverage> = true;
void _sameType;

const MANIFEST = {
	entry_url: 'https://venue.example/',
	pages: [
		{ url: 'https://venue.example/' },
		{ url: 'https://venue.example/menu' },
		{ url: 'https://venue.example/drinks' },
		{ url: 'https://venue.example/careers' }
	]
};

describe('page_coverage wire contract', () => {
	test('every field the UI reads is present and of the right kind', () => {
		// A value-level check of the fields RunDetail's navigation tab touches. The
		// crash was `.length` on undefined, so the array-ness is the point.
		const coverage = pageCoverage(MANIFEST as never, ['https://venue.example/menu']);
		expect(coverage).not.toBeNull();
		expect(typeof coverage?.available).toBe('number');
		expect(typeof coverage?.visited).toBe('number');
		expect(typeof coverage?.ratio).toBe('number');
		expect(Array.isArray(coverage?.unvisited)).toBe(true);
		expect(Array.isArray(coverage?.off_manifest)).toBe(true);
	});

	test('no menu_* field comes back — the ratio was removed as unsound', () => {
		// Guards the direction that broke: a consumer reading what the producer
		// stopped emitting. Reintroducing a menu ratio must be a deliberate change
		// here, not a silent one.
		const coverage = pageCoverage(MANIFEST as never, []) as unknown as Record<string, unknown>;
		for (const key of ['menu_available', 'menu_visited', 'menu_ratio', 'menu_unvisited']) {
			expect(coverage).not.toHaveProperty(key);
		}
	});

	test('unvisited carries every blind spot, menu-word URLs floated to the top', () => {
		const coverage = pageCoverage(MANIFEST as never, ['https://venue.example/']);
		// Both /drinks and /menu carry menu words, so they lead (alphabetically
		// between themselves); /careers does not, so it sinks. The sort is a READING
		// HINT, never a filter — a page without a menu word can still be a menu page
		// (New York Fries serves its from /fries and /poutine), so nothing is
		// dropped and the whole list has to be read.
		expect(coverage?.unvisited).toEqual([
			'https://venue.example/drinks',
			'https://venue.example/menu',
			'https://venue.example/careers'
		]);
	});

	test('a task with no manifest yields null, which the UI renders as a message', () => {
		expect(pageCoverage(undefined, [])).toBeNull();
		expect(pageCoverage({ entry_url: 'x', pages: [] } as never, [])).toBeNull();
	});
});
