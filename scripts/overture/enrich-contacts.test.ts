import { test, expect } from 'bun:test';
import {
	cuisineForCategory,
	isOvertureSourced,
	overtureSource,
	pickWebsite,
	planOvertureBank,
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
