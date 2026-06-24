import { test, expect } from 'bun:test';
import {
	matchOverturePlaces,
	nameRelated,
	composeOvertureAddress,
	type AddresslessPoi,
	type OverturePlace
} from './match-overture';
import { normalizeName } from '../osm/search-poi';

test('nameRelated handles short brand tokens and rejects unrelated names', () => {
	const n = normalizeName;
	expect(nameRelated(n('KFC'), n('KFC'))).toBe(true);
	expect(nameRelated(n('KFC'), n('Taco Bell / KFC'))).toBe(true); // short token contained
	expect(nameRelated(n('Quiznos'), n('Quiznos Subs'))).toBe(true);
	expect(nameRelated(n('KFC'), n('Subway'))).toBe(false);
	expect(nameRelated(n(''), n('KFC'))).toBe(false);
});

test('composeOvertureAddress joins present parts and returns null when all empty', () => {
	expect(
		composeOvertureAddress({
			freeform: '8737 120 St',
			locality: 'Delta',
			region: 'BC',
			postcode: 'V4C 6R4'
		})
	).toBe('8737 120 St, Delta, BC, V4C 6R4');
	expect(composeOvertureAddress({ freeform: '12 Main St' })).toBe('12 Main St');
	expect(composeOvertureAddress({ freeform: null, locality: '  ' })).toBeNull();
});

const pois: AddresslessPoi[] = [
	{ osm_id: 'n1', name: 'KFC', latitude: 49.281, longitude: -123.121 },
	{ osm_id: 'n2', name: 'Quiznos', latitude: 49.3, longitude: -123.2 },
	{ osm_id: 'n3', name: 'KFC', latitude: 49.5, longitude: -123.5 } // no Overture place nearby
];

function place(
	over: Partial<OverturePlace> & Pick<OverturePlace, 'id' | 'latitude' | 'longitude'>
): OverturePlace {
	return { name: 'KFC', address: '1 Test Rd', ...over };
}

test('matches each POI to the nearest name-related place within radius, with provenance', () => {
	const places: OverturePlace[] = [
		// ~16 m from n1 — the correct match
		place({
			id: 'ov-a',
			name: 'Taco Bell / KFC',
			latitude: 49.28114,
			longitude: -123.121,
			address: '857 Terlane Ave, Victoria, BC'
		}),
		// a second, farther KFC (~120 m from n1) — should lose to ov-a
		place({
			id: 'ov-b',
			name: 'KFC',
			latitude: 49.282,
			longitude: -123.121,
			address: '999 Far St'
		}),
		// the Quiznos near n2
		place({
			id: 'ov-c',
			name: 'Quiznos',
			latitude: 49.30009,
			longitude: -123.2,
			address: '5 Sub Lane, Burnaby, BC'
		})
	];
	const matches = matchOverturePlaces(pois, places, { radiusM: 100, releaseLabel: '2026-06-17.0' });
	const byId = Object.fromEntries(matches.map((m) => [m.osm_id, m]));

	expect(matches.length).toBe(2); // n3 has no nearby place
	expect(byId['n1'].address).toBe('857 Terlane Ave, Victoria, BC'); // nearest KFC, not ov-b
	expect(byId['n1'].address_source).toBe('overture:ov-a (2026-06-17.0)');
	expect(byId['n1'].distance_m).toBeLessThan(30);
	expect(byId['n2'].address).toBe('5 Sub Lane, Burnaby, BC');
	expect(byId['n3']).toBeUndefined();
});

test('does not match a different brand even when it is the closest place', () => {
	const places: OverturePlace[] = [
		place({
			id: 'ov-x',
			name: 'Subway',
			latitude: 49.281,
			longitude: -123.121,
			address: '1 Sandwich Way'
		})
	];
	const matches = matchOverturePlaces(pois, places, { radiusM: 100, releaseLabel: 'r' });
	expect(matches.find((m) => m.osm_id === 'n1')).toBeUndefined(); // KFC must not take Subway's address
});

test('respects the radius — a far same-brand place is not matched', () => {
	const places: OverturePlace[] = [
		place({
			id: 'ov-far',
			name: 'KFC',
			latitude: 49.2825,
			longitude: -123.121,
			address: 'Too Far Rd'
		}) // ~167 m from n1
	];
	expect(matchOverturePlaces(pois, places, { radiusM: 100, releaseLabel: 'r' }).length).toBe(0);
	expect(matchOverturePlaces(pois, places, { radiusM: 300, releaseLabel: 'r' }).length).toBe(1);
});
