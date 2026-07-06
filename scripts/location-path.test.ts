// Exercises the shared `/locations/<…>` helpers (src/lib/location-path.ts) — the
// parser both the map page (+page.svelte) and its server 404/301 gate
// (+page.server.ts) use to decide whether a pathname names a venue and to
// recover the id, plus the slug builder that mints the canonical descriptive
// URL. What the parser accepts/rejects and how the builder rounds-trips back
// through it are load-bearing on both sides.
import { expect, test, describe } from 'bun:test';
import { idFromPath, locationSlug, locationPath } from '../src/lib/location-path';

const UUID = '9f0e8d7c-6b5a-4321-8765-4321fedcba98';

describe('idFromPath', () => {
	test('extracts a bare trailing id from a venue path', () => {
		expect(idFromPath('/locations/abc-123')).toBe('abc-123');
		expect(idFromPath(`/locations/${UUID}`)).toBe(UUID);
	});

	test('recovers the trailing UUID from a descriptive slug', () => {
		// `<name>-<city>-<uuid>` → the id is the trailing UUID; the slug prefix is
		// ignored, so a wrong/stale prefix still resolves (the server then 301s it).
		expect(idFromPath(`/locations/prado-cafe-vancouver-${UUID}`)).toBe(UUID);
		expect(idFromPath(`/locations/some-other-slug-${UUID}`)).toBe(UUID);
		// A name whose slug coincidentally embeds a UUID-shaped run can't fool it:
		// the id is the LAST ($-anchored) UUID, the one the builder appended.
		expect(idFromPath(`/locations/cafe-${UUID}-${UUID}`)).toBe(UUID);
	});

	test('treats a non-UUID segment as a whole legacy id', () => {
		// Legacy short-slug ids (no UUID) are never given a descriptive prefix, so
		// the whole segment is the id — a bare `/locations/wr-damianos` resolves.
		expect(idFromPath('/locations/wr-damianos')).toBe('wr-damianos');
	});

	test('decodes a percent-encoded id', () => {
		expect(idFromPath('/locations/caf%C3%A9%20nine')).toBe('café nine');
		expect(idFromPath('/locations/a%2Fb')).toBe('a/b');
	});

	test('matches only a trailing segment', () => {
		// The id must be the LAST path segment: extra segments, a trailing slash,
		// or an empty segment all mean "not a venue URL".
		expect(idFromPath('/locations/abc/extra')).toBeNull();
		expect(idFromPath('/locations/abc/')).toBeNull();
		expect(idFromPath('/locations/')).toBeNull();
		expect(idFromPath('/locations')).toBeNull();
	});

	test('returns null for non-location paths', () => {
		expect(idFromPath('/')).toBeNull();
		expect(idFromPath('/about')).toBeNull();
		expect(idFromPath('/sitemap.xml')).toBeNull();
		expect(idFromPath('/ca/on/toronto')).toBeNull();
	});

	test('throws on malformed percent-encoding', () => {
		// SvelteKit rejects undecodable paths with a 400 before routing, so this
		// is normally unreachable — but the server load still maps a throw here
		// to a 404 as belt-and-braces, so the throwing behaviour is contractual.
		expect(() => idFromPath('/locations/%zz')).toThrow();
	});
});

describe('locationSlug / locationPath', () => {
	test('builds <name>-<city>-<uuid> for a UUID id', () => {
		const loc = { id: UUID, name: 'Prado Café', city: 'Vancouver' };
		expect(locationSlug(loc)).toBe(`prado-cafe-vancouver-${UUID}`);
		expect(locationPath(loc)).toBe(`/locations/prado-cafe-vancouver-${UUID}`);
	});

	test('round-trips back through idFromPath', () => {
		const loc = { id: UUID, name: "O'Malley & Sons <Deli>", city: 'Saint-Jean' };
		expect(idFromPath(locationPath(loc))).toBe(UUID);
	});

	test('gives a legacy short-slug id no descriptive prefix', () => {
		const loc = { id: 'wr-damianos', name: "Damiano's Pizza", city: 'Waterloo' };
		expect(locationSlug(loc)).toBe('wr-damianos');
		expect(idFromPath(locationPath(loc))).toBe('wr-damianos');
	});

	test('falls back to the bare id when name+city yield no slug', () => {
		const loc = { id: UUID, name: '—', city: '—' };
		expect(locationSlug(loc)).toBe(UUID);
	});
});
