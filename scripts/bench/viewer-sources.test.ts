import { describe, expect, test } from 'bun:test';
import { buildCities, buildSummary, foldCity } from './viewer-sources';

/** Minimal Loaded shape, structurally typed — the interface itself is internal. */
function loadedFixture() {
	return {
		osm: [
			{ region: 'BC', city: 'Vancouver', n: 100, web: 80 },
			{ region: 'BC', city: 'Montréal-sur-mer', n: 5, web: 2 },
			{ region: 'ON', city: 'Toronto', n: 200, web: 150 }
		],
		leads: [
			{ region: 'BC', city: 'Vancouver', n: 40, web: 35 },
			{ region: 'BC', city: 'MONTREAL-SUR-MER', n: 3, web: 1 }
		],
		mapOpen: [
			{ region: 'BC', city: 'Vancouver', n: 30, web: 25 },
			{ region: 'QC', city: 'Gatineau', n: 7, web: 6 }
		],
		mapClosedTotal: 2,
		osmTotal: 305,
		osmNamed: 300,
		osmWeb: 232,
		osmMatched: 150,
		leadsTotal: 43,
		leadsWeb: 36,
		leadsRelease: '2026-06-17.0',
		mapOpenTotal: 37,
		poiMtime: 1_700_000_000_000,
		mirrorMtime: 1_700_000_100_000,
		mirrorFound: true
	};
}

describe('foldCity', () => {
	test('folds accents and case so one city joins across sources', () => {
		expect(foldCity('Montréal')).toBe(foldCity('MONTREAL'));
		expect(foldCity('  Québec ')).toBe('quebec');
	});
});

describe('buildSummary', () => {
	test('unique = osm + leads, remaining subtracts map, floored at zero', () => {
		const summary = buildSummary(loadedFixture());
		const regions = summary.countries?.[0].regions ?? [];
		const bc = regions.find((row) => row.region === 'BC');
		expect(bc).toEqual({
			region: 'BC',
			osm: 105,
			osm_web: 82,
			leads: 43,
			leads_web: 36,
			map_open: 30,
			map_open_web: 25,
			map_closed: 0,
			unique_estimate: 148,
			unique_web: 118,
			remaining_estimate: 118,
			remaining_web: 93
		});
		// A region only the map knows about still appears, with remaining 0 not
		// negative — the estimate must never claim negative work.
		const qc = regions.find((row) => row.region === 'QC');
		expect(qc?.remaining_estimate).toBe(0);
		expect(qc?.remaining_web).toBe(0);
	});

	test('regions sort by unique estimate, largest first', () => {
		const regions = buildSummary(loadedFixture()).countries?.[0].regions ?? [];
		const uniques = regions.map((row) => row.unique_estimate);
		expect(uniques).toEqual([...uniques].toSorted((a, b) => b - a));
	});

	test('website totals surface on the source tiles', () => {
		const sources = buildSummary(loadedFixture()).sources;
		expect(sources?.osm.with_website).toBe(232);
		expect(sources?.overture_leads.with_website).toBe(36);
	});
});

describe('buildCities', () => {
	test('joins per-source counts on the folded city name, both variants', () => {
		const cities = buildCities(loadedFixture(), 'BC');
		const montreal = cities.find((row) => foldCity(row.city) === 'montreal-sur-mer');
		// OSM's accented spelling and the leads' shouted spelling are ONE row.
		expect(montreal).toBeDefined();
		expect(montreal?.osm).toBe(5);
		expect(montreal?.leads).toBe(3);
		expect(montreal?.unique_estimate).toBe(8);
		expect(montreal?.unique_web).toBe(3);

		const vancouver = cities.find((row) => row.city === 'Vancouver');
		expect(vancouver?.remaining_estimate).toBe(110);
		// 80 + 35 website-bearing, minus 25 website-bearing on the map.
		expect(vancouver?.remaining_web).toBe(90);
	});

	test('a region with no rows yields an empty list', () => {
		expect(buildCities(loadedFixture(), 'NT')).toEqual([]);
	});
});
