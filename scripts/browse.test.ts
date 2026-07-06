// Exercises the geographic browse tree (#217): the pure path/diet-slug helpers
// ($lib/browse), the code→name display labels ($lib/address), and the db reads
// behind the country/region/city/diet pages — including that closed venues are
// excluded and that a diet page's membership matches the map's diet filter
// (vegan satisfies the vegetarian/dairy-free filters via implication).
import { test, expect, describe } from 'bun:test';
import {
	dietSlug,
	dietTagIdFromSlug,
	citySlug,
	countryPath,
	regionPath,
	cityPath,
	dietCityPath,
	mergeCitiesBySlug,
	DIETARY_TAGS
} from '../src/lib/browse';
import { regionLabel, countryLabel } from '../src/lib/address';
import { dietFilterTagIds } from '../src/lib/tags';
import {
	getBrowseCountries,
	getBrowseRegions,
	getBrowseCities,
	getBrowseVenues,
	getBrowseVenuesByDiet,
	getCityDietaryTags
} from '../src/lib/server/db';
import {
	insertLocations,
	setLocationClosed,
	type LocationInsert
} from '../src/lib/server/db-write';
import { freshDb } from './test-d1';

describe('diet slug ↔ tag id', () => {
	test('maps underscores to hyphens and back, only for dietary tags', () => {
		expect(dietSlug('gluten_free')).toBe('gluten-free');
		expect(dietSlug('vegan')).toBe('vegan');
		expect(dietTagIdFromSlug('gluten-free')).toBe('gluten_free');
		expect(dietTagIdFromSlug('vegan')).toBe('vegan');
		expect(dietTagIdFromSlug('nut-free')).toBe('nut_free');
		// Not a dietary tag (course), or gibberish → null (so the matcher rejects it).
		expect(dietTagIdFromSlug('food')).toBeNull();
		expect(dietTagIdFromSlug('dessert')).toBeNull();
		expect(dietTagIdFromSlug('bogus')).toBeNull();
	});

	test('DIETARY_TAGS is exactly the six dietary tags', () => {
		expect(DIETARY_TAGS.map((t) => t.id).toSorted()).toEqual(
			['dairy_free', 'gluten_free', 'halal', 'nut_free', 'vegan', 'vegetarian'].toSorted()
		);
	});
});

describe('browse path builders', () => {
	test('lower-case codes and slugified city', () => {
		expect(countryPath('CA')).toBe('/ca');
		expect(regionPath('CA', 'ON')).toBe('/ca/on');
		expect(cityPath('CA', 'ON', 'North York')).toBe('/ca/on/north-york');
		expect(citySlug('Saint-Jean-sur-Richelieu')).toBe('saint-jean-sur-richelieu');
		expect(dietCityPath('CA', 'ON', 'Toronto', 'gluten_free')).toBe('/ca/on/toronto/gluten-free');
	});
});

describe('mergeCitiesBySlug', () => {
	test('collapses spellings that share a slug, summing counts, top spelling wins', () => {
		// Ordered by count desc (as getBrowseCities returns): the most-covered
		// spelling comes first and names the merged row.
		const merged = mergeCitiesBySlug([
			{ value: 'Grand Forks', count: 4 },
			{ value: 'Fort St. John', count: 10 },
			{ value: 'GRAND FORKS', count: 1 },
			{ value: 'Fort St John', count: 1 },
			{ value: 'Vancouver', count: 264 }
		]);
		expect(merged).toEqual([
			{ value: 'Grand Forks', count: 5 },
			{ value: 'Fort St. John', count: 11 },
			{ value: 'Vancouver', count: 264 }
		]);
		// Every merged row now yields a unique city href — the invariant the keyed
		// {#each} on the region page needs.
		const hrefs = merged.map((c) => cityPath('CA', 'BC', c.value));
		expect(new Set(hrefs).size).toBe(hrefs.length);
	});

	test('leaves already-distinct cities untouched, order preserved', () => {
		const cities = [
			{ value: 'Toronto', count: 2 },
			{ value: 'Ottawa', count: 1 }
		];
		expect(mergeCitiesBySlug(cities)).toEqual(cities);
	});
});

describe('region/country labels', () => {
	test('code → display name, case-insensitive, with a sane fallback', () => {
		expect(regionLabel('ON')).toBe('Ontario');
		expect(regionLabel('bc')).toBe('British Columbia');
		expect(regionLabel('NY')).toBe('New York');
		expect(regionLabel('ZZ')).toBe('ZZ');
		expect(countryLabel('CA')).toBe('Canada');
		expect(countryLabel('us')).toBe('United States');
		expect(countryLabel('ZZ')).toBe('ZZ');
	});
});

function venue(over: Partial<LocationInsert> & { name: string }): LocationInsert {
	return {
		category: 'restaurant',
		latitude: 43.65,
		longitude: -79.38,
		street: '1 Test St',
		city: 'Toronto',
		region: 'ON',
		postcode: null,
		country: 'CA',
		phone: null,
		website: null,
		...over
	};
}

describe('browse db reads', () => {
	async function seed() {
		const db = freshDb();
		const [green, meat, ottawa, prado, ghost] = await insertLocations(db, [
			venue({ name: 'Green Bowl', items: [{ item_name: 'Tofu Bowl', tags: ['vegan'] }] }),
			venue({ name: 'Meat House', items: [{ item_name: 'Steak', tags: ['food'] }] }),
			venue({ name: 'Byward Bites', city: 'Ottawa' }),
			venue({
				name: 'Prado Cafe',
				city: 'Vancouver',
				region: 'BC',
				latitude: 49.2,
				longitude: -123.1
			}),
			venue({ name: 'Ghost Kitchen', latitude: 43.66, longitude: -79.39 })
		]);
		// Ghost Kitchen closes — it must vanish from every browse read but never
		// break counts.
		await setLocationClosed(db, ghost, 1_700_000_000_000, 'Permanently closed');
		return { db, green, meat, ottawa, prado, ghost };
	}

	test('countries/regions/cities count only open venues, most-covered first', async () => {
		const { db } = await seed();
		expect(await getBrowseCountries(db)).toEqual([{ value: 'CA', count: 4 }]);
		// ON has Green Bowl + Meat House + Byward Bites (Ghost closed); BC has Prado.
		expect(await getBrowseRegions(db, 'CA')).toEqual([
			{ value: 'ON', count: 3 },
			{ value: 'BC', count: 1 }
		]);
		expect(await getBrowseCities(db, 'CA', 'ON')).toEqual([
			{ value: 'Toronto', count: 2 },
			{ value: 'Ottawa', count: 1 }
		]);
	});

	test('city venue list excludes closed and sorts by name', async () => {
		const { db } = await seed();
		const venues = await getBrowseVenues(db, 'CA', 'ON', ['Toronto']);
		expect(venues.map((v) => v.name)).toEqual(['Green Bowl', 'Meat House']);
		// Carries the fields a link needs: id (for the slug) + a derived address.
		expect(venues[0].address).toBe('1 Test St, Toronto, ON');
	});

	test('diet page membership mirrors the map filter (vegan ⊂ vegetarian)', async () => {
		const { db } = await seed();
		// Green Bowl has a vegan item; Meat House does not.
		const vegan = await getBrowseVenuesByDiet(
			db,
			'CA',
			'ON',
			['Toronto'],
			dietFilterTagIds('vegan')
		);
		expect(vegan.map((v) => v.name)).toEqual(['Green Bowl']);
		// A vegan item satisfies the vegetarian filter (implication), so the
		// vegetarian page is non-empty too.
		const veg = await getBrowseVenuesByDiet(
			db,
			'CA',
			'ON',
			['Toronto'],
			dietFilterTagIds('vegetarian')
		);
		expect(veg.map((v) => v.name)).toEqual(['Green Bowl']);
		// Nothing is halal here.
		const halal = await getBrowseVenuesByDiet(
			db,
			'CA',
			'ON',
			['Toronto'],
			dietFilterTagIds('halal')
		);
		expect(halal).toEqual([]);
	});

	test('city dietary tags drive the cross-links (only vegan is stored)', async () => {
		const { db } = await seed();
		const present = await getCityDietaryTags(db, 'CA', 'ON', ['Toronto']);
		// Vegan is stored; its entailed tags are stripped on write, so they are not
		// present as raw tags — the city page re-expands via dietFilterTagIds.
		expect([...present]).toEqual(['vegan']);
		// Which diets get a cross-link: those whose filter set intersects {vegan}.
		const linked = DIETARY_TAGS.filter((t) =>
			dietFilterTagIds(t.id).some((id) => present.has(id))
		).map((t) => t.id);
		expect(linked.toSorted()).toEqual(['dairy_free', 'vegan', 'vegetarian'].toSorted());
	});
});
