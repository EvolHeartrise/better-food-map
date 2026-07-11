import { test, expect } from 'bun:test';
import {
	cuisineForCategory,
	isOvertureSourced,
	massClearExceeded,
	overtureSource,
	pickWebsite,
	planOvertureBank,
	planOvertureClear,
	type OvertureEatery
} from './enrich-contacts';
import type { ContactPoi } from '../osm/poi-store';

const RELEASE = '2026-06-17.0';

function contactPoi(over: Partial<ContactPoi> & Pick<ContactPoi, 'osm_id'>): ContactPoi {
	return {
		name: 'Test POI',
		latitude: 49.28,
		longitude: -123.12,
		website: null,
		phone: null,
		cuisine: null,
		website_source: null,
		phone_source: null,
		cuisine_source: null,
		overture_id: null,
		...over
	};
}

function eatery(over: Partial<OvertureEatery> & Pick<OvertureEatery, 'id'>): OvertureEatery {
	return {
		name: 'Test POI',
		latitude: 49.28,
		longitude: -123.12,
		website: null,
		phone: null,
		social: null,
		category: null,
		operating_status: 'open',
		...over
	};
}

test('overtureSource matches the address_source citation format', () => {
	expect(overtureSource('abc-123', RELEASE)).toBe('overture:abc-123 (2026-06-17.0)');
	expect(isOvertureSourced('overture:abc-123 (2026-06-17.0)')).toBe(true);
	expect(isOvertureSourced(null)).toBe(false);
});

test('pickWebsite prefers a real website over a social profile, but takes the profile alone', () => {
	expect(
		pickWebsite({ website: 'https://kfc.ca/menu', social: 'https://www.facebook.com/kfc' })
	).toBe('https://kfc.ca/menu');
	// The "website" field itself can be a facebook URL — a real site elsewhere wins.
	expect(
		pickWebsite({ website: 'https://www.facebook.com/152252924791184', social: 'https://kfc.ca' })
	).toBe('https://kfc.ca');
	// Only a facebook-style URL: still better than nothing.
	expect(pickWebsite({ website: 'https://www.facebook.com/kfc', social: null })).toBe(
		'https://www.facebook.com/kfc'
	);
	expect(pickWebsite({ website: null, social: 'https://linktr.ee/somecafe' })).toBe(
		'https://linktr.ee/somecafe'
	);
	expect(pickWebsite({ website: null, social: null })).toBeNull();
	// Non-URL junk is dropped rather than stored.
	expect(pickWebsite({ website: 'not a url', social: null })).toBeNull();
});

test('cuisineForCategory maps cuisine-specific categories and skips generic ones', () => {
	expect(cuisineForCategory('pizza_restaurant')).toBe('pizza');
	expect(cuisineForCategory('sushi_restaurant')).toBe('sushi');
	expect(cuisineForCategory('steakhouse')).toBe('steak_house'); // OSM's established value
	expect(cuisineForCategory('coffee_shop')).toBe('coffee_shop');
	expect(cuisineForCategory('bubble_tea')).toBe('bubble_tea');
	// Generic venue types say nothing about the food.
	for (const generic of [
		'restaurant',
		'fast_food_restaurant',
		'cafe',
		'bar',
		'diner',
		'food_court',
		'bar_and_grill_restaurant'
	]) {
		expect(cuisineForCategory(generic)).toBeNull();
	}
	// Dietary-shaped categories never become cuisine (source-asserted policy).
	expect(cuisineForCategory('vegan_restaurant')).toBeNull();
	expect(cuisineForCategory('halal_restaurant')).toBeNull();
	expect(cuisineForCategory(null)).toBeNull();
});

test('planOvertureBank fills gaps with provenance and always banks the match', () => {
	const poi = contactPoi({ osm_id: 'n1' });
	const e = eatery({
		id: 'ov-1',
		website: 'https://pho-real.ca',
		phone: '+16045550123',
		category: 'vietnamese_restaurant'
	});
	const u = planOvertureBank(poi, e, 12.3456, RELEASE);
	expect(u).toEqual({
		osm_id: 'n1',
		overture_id: 'ov-1',
		overture_distance_m: 12.3,
		website: 'https://pho-real.ca',
		website_source: 'overture:ov-1 (2026-06-17.0)',
		phone: '+16045550123',
		phone_source: 'overture:ov-1 (2026-06-17.0)',
		cuisine: 'vietnamese',
		cuisine_source: 'overture:ov-1 (2026-06-17.0)'
	});
});

test('planOvertureBank NEVER overwrites OSM-sourced values, but still banks the id', () => {
	const poi = contactPoi({
		osm_id: 'n1',
		website: 'https://osm-site.ca',
		phone: '+16040000000',
		cuisine: 'burger'
		// all *_source null: these are OSM's own values
	});
	const e = eatery({
		id: 'ov-1',
		website: 'https://overture-site.ca',
		phone: '+16049999999',
		category: 'pizza_restaurant'
	});
	const u = planOvertureBank(poi, e, 5, RELEASE);
	expect(u.overture_id).toBe('ov-1'); // identity join banked regardless
	expect(u.overture_distance_m).toBe(5);
	expect(u.website).toBe('https://osm-site.ca');
	expect(u.website_source).toBeNull();
	expect(u.phone).toBe('+16040000000');
	expect(u.phone_source).toBeNull();
	expect(u.cuisine).toBe('burger');
	expect(u.cuisine_source).toBeNull();
});

test('planOvertureBank re-fills its own previous fills from the CURRENT match (idempotent)', () => {
	const poi = contactPoi({
		osm_id: 'n1',
		website: 'https://stale-from-old-release.ca',
		website_source: 'overture:old-id (2026-03-19.0)',
		phone: '+16041111111',
		phone_source: 'overture:old-id (2026-03-19.0)'
	});
	// The current match has a website but no phone: the stale overture phone is
	// cleared rather than left as a ghost of a previous release.
	const e = eatery({ id: 'ov-new', website: 'https://fresh.ca' });
	const u = planOvertureBank(poi, e, 8, RELEASE);
	expect(u.website).toBe('https://fresh.ca');
	expect(u.website_source).toBe('overture:ov-new (2026-06-17.0)');
	expect(u.phone).toBeNull();
	expect(u.phone_source).toBeNull();
});

test('planOvertureBank treats a blank OSM value as a gap', () => {
	const poi = contactPoi({ osm_id: 'n1', website: '   ' });
	const u = planOvertureBank(poi, eatery({ id: 'ov-1', website: 'https://x.ca' }), 3, RELEASE);
	expect(u.website).toBe('https://x.ca');
	expect(u.website_source).toBe('overture:ov-1 (2026-06-17.0)');
});

test('a permanently_closed place is banked as identity but never donates fills', () => {
	const poi = contactPoi({ osm_id: 'n1' });
	const e = eatery({
		id: 'ov-dead',
		website: 'https://gone.ca',
		phone: '+16040000001',
		category: 'pizza_restaurant',
		operating_status: 'permanently_closed'
	});
	const u = planOvertureBank(poi, e, 4, RELEASE);
	// Identity banked — this is the closure signal the later pass reads.
	expect(u.overture_id).toBe('ov-dead');
	expect(u.overture_distance_m).toBe(4);
	// No fills from a venue that no longer operates.
	expect(u.website).toBeNull();
	expect(u.website_source).toBeNull();
	expect(u.phone).toBeNull();
	expect(u.cuisine).toBeNull();
});

test('a previous fill is cleared when its place is now permanently_closed; OSM values stay', () => {
	const poi = contactPoi({
		osm_id: 'n1',
		website: 'https://from-overture.ca',
		website_source: overtureSource('ov-dead', RELEASE),
		phone: '+16040000000' // OSM's own (phone_source null)
	});
	const e = eatery({
		id: 'ov-dead',
		website: 'https://from-overture.ca',
		operating_status: 'permanently_closed'
	});
	const u = planOvertureBank(poi, e, 4, RELEASE);
	expect(u.website).toBeNull(); // overture-sourced fill recomputed → gone
	expect(u.website_source).toBeNull();
	expect(u.phone).toBe('+16040000000'); // OSM-owned, untouched
	expect(u.phone_source).toBeNull();
});

test('a temporarily_closed place still donates fills (the business exists)', () => {
	const poi = contactPoi({ osm_id: 'n1' });
	const e = eatery({
		id: 'ov-seasonal',
		website: 'https://seasonal.ca',
		operating_status: 'temporarily_closed'
	});
	const u = planOvertureBank(poi, e, 4, RELEASE);
	expect(u.website).toBe('https://seasonal.ca');
	expect(u.website_source).toBe(overtureSource('ov-seasonal', RELEASE));
});

test('planOvertureClear nulls overture-sourced fields and keeps OSM-owned ones', () => {
	const poi = contactPoi({
		osm_id: 'n1',
		overture_id: 'ov-gone',
		website: 'https://from-overture.ca',
		website_source: overtureSource('ov-gone', RELEASE),
		phone: '+16040000000', // OSM's own
		cuisine: 'pizza',
		cuisine_source: overtureSource('ov-gone', RELEASE)
	});
	expect(planOvertureClear(poi)).toEqual({
		osm_id: 'n1',
		website: null,
		website_source: null,
		phone: '+16040000000',
		phone_source: null,
		cuisine: null,
		cuisine_source: null
	});
});

test('massClearExceeded trips above the threshold and never on a first run', () => {
	expect(massClearExceeded(0, 0)).toBe(false); // first run: nothing banked yet
	expect(massClearExceeded(0, 100)).toBe(false);
	expect(massClearExceeded(20, 100)).toBe(false); // exactly the threshold: allowed
	expect(massClearExceeded(21, 100)).toBe(true); // a partial/regional file's tell
	expect(massClearExceeded(100, 100)).toBe(true);
});
