// Exercises the shared `/locations/<id>` path parser (src/lib/location-path.ts)
// — the ONE helper both the map page (+page.svelte) and its server 404 gate
// (+page.server.ts) use to decide whether a pathname names a venue, so what it
// accepts and rejects is load-bearing on both sides.
import { expect, test, describe } from 'bun:test';
import { idFromPath } from '../src/lib/location-path';

describe('idFromPath', () => {
	test('extracts the trailing id from a venue path', () => {
		expect(idFromPath('/locations/abc-123')).toBe('abc-123');
		expect(idFromPath('/locations/9f0e8d7c-6b5a-4321-8765-4321fedcba98')).toBe(
			'9f0e8d7c-6b5a-4321-8765-4321fedcba98'
		);
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
	});

	test('throws on malformed percent-encoding', () => {
		// SvelteKit rejects undecodable paths with a 400 before routing, so this
		// is normally unreachable — but the server load still maps a throw here
		// to a 404 as belt-and-braces, so the throwing behaviour is contractual.
		expect(() => idFromPath('/locations/%zz')).toThrow();
	});
});
