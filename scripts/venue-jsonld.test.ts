// Pins the schema.org JSON-LD graph (src/lib/venue-jsonld.ts) emitted into the
// venue head on a hard /locations/<id> load (issue #218) — the machine-readable
// structured data Google's Rich Results Test parses. The exact @type mapping,
// address/geo/menu shape and diet-URL mapping are asserted here so a refactor
// can't silently drop or malform a field crawlers depend on.
import { expect, test, describe } from 'bun:test';
import {
	venueJsonLd,
	venueJsonLdScript,
	type JsonLdVenue,
	type JsonLdItem
} from '../src/lib/venue-jsonld';
import { CANONICAL_ORIGIN } from '../src/lib/canonical';

/** A fully-populated venue; override any field per test. */
function venue(overrides: Partial<JsonLdVenue> = {}): JsonLdVenue {
	return {
		id: '9f0e8d7c-6b5a-4321-8765-4321fedcba98',
		name: 'Prado Café',
		category: 'cafe',
		latitude: 49.26543,
		longitude: -123.06789,
		street: '1938 Commercial Dr',
		city: 'Vancouver',
		region: 'BC',
		postcode: 'V5N 4A7',
		country: 'CA',
		phone: '+1 604-555-0100',
		website: 'https://pradocafe.example',
		menu: [],
		...overrides
	};
}

/** A menu item with sensible defaults. */
function item(overrides: Partial<JsonLdItem> = {}): JsonLdItem {
	return {
		item_name: 'Flat White',
		description: null,
		price: null,
		currency: 'CAD',
		tags: [],
		...overrides
	};
}

/** Tag edges, all non-optional unless a `?` suffix marks them optional. */
function tags(...ids: string[]): JsonLdItem['tags'] {
	return ids.map((id) => ({ id: id.replace(/\?$/, ''), optional: id.endsWith('?') }));
}

describe('venueJsonLd @type', () => {
	test('maps each category to its schema.org FoodEstablishment subtype', () => {
		expect(venueJsonLd(venue({ category: 'cafe' }))['@type']).toBe('CafeOrCoffeeShop');
		expect(venueJsonLd(venue({ category: 'fast_food' }))['@type']).toBe('FastFoodRestaurant');
		expect(venueJsonLd(venue({ category: 'restaurant' }))['@type']).toBe('Restaurant');
		expect(venueJsonLd(venue({ category: 'bakery' }))['@type']).toBe('Bakery');
	});

	test('falls back to FoodEstablishment when the category is unset', () => {
		expect(venueJsonLd(venue({ category: null }))['@type']).toBe('FoodEstablishment');
	});

	test('carries the schema.org context', () => {
		expect(venueJsonLd(venue())['@context']).toBe('https://schema.org');
	});
});

describe('venueJsonLd identity', () => {
	test('name is verbatim and url is the canonical descriptive slug (issue #221)', () => {
		const node = venueJsonLd(venue());
		expect(node.name).toBe('Prado Café');
		expect(node.url).toBe(
			`${CANONICAL_ORIGIN}/locations/prado-cafe-vancouver-9f0e8d7c-6b5a-4321-8765-4321fedcba98`
		);
	});

	test('the venue website rides sameAs; telephone carries the phone', () => {
		const node = venueJsonLd(venue());
		expect(node.sameAs).toBe('https://pradocafe.example');
		expect(node.telephone).toBe('+1 604-555-0100');
	});

	test('omits sameAs and telephone when absent', () => {
		const node = venueJsonLd(venue({ website: null, phone: null }));
		expect('sameAs' in node).toBe(false);
		expect('telephone' in node).toBe(false);
	});
});

describe('venueJsonLd address & geo', () => {
	test('maps the structured parts 1:1 onto PostalAddress', () => {
		expect(venueJsonLd(venue()).address).toEqual({
			'@type': 'PostalAddress',
			streetAddress: '1938 Commercial Dr',
			addressLocality: 'Vancouver',
			addressRegion: 'BC',
			postalCode: 'V5N 4A7',
			addressCountry: 'CA'
		});
	});

	test('drops a missing postcode rather than emitting a null', () => {
		const address = venueJsonLd(venue({ postcode: null })).address as Record<string, unknown>;
		expect('postalCode' in address).toBe(false);
		expect(address.addressCountry).toBe('CA');
	});

	test('emits geo coordinates verbatim (no rounding)', () => {
		expect(venueJsonLd(venue()).geo).toEqual({
			'@type': 'GeoCoordinates',
			latitude: 49.26543,
			longitude: -123.06789
		});
	});
});

describe('venueJsonLd hasMenu', () => {
	test('omits hasMenu for an empty menu', () => {
		expect('hasMenu' in venueJsonLd(venue({ menu: [] }))).toBe(false);
	});

	test('wraps items in a Menu with hasMenuItem', () => {
		const node = venueJsonLd(venue({ menu: [item({ item_name: 'Latte' })] }));
		expect(node.hasMenu).toEqual({
			'@type': 'Menu',
			hasMenuItem: [{ '@type': 'MenuItem', name: 'Latte' }]
		});
	});

	test('carries description and a priced Offer when present', () => {
		const node = venueJsonLd(
			venue({ menu: [item({ item_name: 'Latte', description: 'Double shot', price: 4.5 })] })
		);
		const items = (node.hasMenu as { hasMenuItem: Record<string, unknown>[] }).hasMenuItem;
		expect(items[0]).toEqual({
			'@type': 'MenuItem',
			name: 'Latte',
			description: 'Double shot',
			offers: { '@type': 'Offer', price: 4.5, priceCurrency: 'CAD' }
		});
	});

	test('emits an Offer for a $0 item (price 0 is not null)', () => {
		const node = venueJsonLd(venue({ menu: [item({ price: 0 })] }));
		const items = (node.hasMenu as { hasMenuItem: Record<string, unknown>[] }).hasMenuItem;
		expect(items[0].offers).toEqual({ '@type': 'Offer', price: 0, priceCurrency: 'CAD' });
	});

	test('honours the item currency', () => {
		const node = venueJsonLd(venue({ menu: [item({ price: 3, currency: 'USD' })] }));
		const items = (node.hasMenu as { hasMenuItem: Record<string, unknown>[] }).hasMenuItem;
		expect((items[0].offers as { priceCurrency: string }).priceCurrency).toBe('USD');
	});
});

describe('venueJsonLd suitableForDiet', () => {
	test('maps the five mappable dietary tags to their RestrictedDiet URLs', () => {
		const node = venueJsonLd(
			venue({ menu: [item({ tags: tags('vegetarian', 'halal', 'gluten_free', 'dairy_free') })] })
		);
		const items = (node.hasMenu as { hasMenuItem: Record<string, unknown>[] }).hasMenuItem;
		expect(items[0].suitableForDiet).toEqual([
			'https://schema.org/VegetarianDiet',
			'https://schema.org/HalalDiet',
			'https://schema.org/GlutenFreeDiet',
			'https://schema.org/LowLactoseDiet'
		]);
	});

	test('expands the vegan implication to vegetarian + low-lactose', () => {
		const node = venueJsonLd(venue({ menu: [item({ tags: tags('vegan') })] }));
		const items = (node.hasMenu as { hasMenuItem: Record<string, unknown>[] }).hasMenuItem;
		expect(items[0].suitableForDiet).toEqual([
			'https://schema.org/VeganDiet',
			'https://schema.org/VegetarianDiet',
			'https://schema.org/LowLactoseDiet'
		]);
	});

	test('nut_free has no RestrictedDiet member, so it yields no suitableForDiet', () => {
		const node = venueJsonLd(venue({ menu: [item({ tags: tags('nut_free') })] }));
		const items = (node.hasMenu as { hasMenuItem: Record<string, unknown>[] }).hasMenuItem;
		expect('suitableForDiet' in items[0]).toBe(false);
	});

	test('course tags never assert a diet', () => {
		const node = venueJsonLd(venue({ menu: [item({ tags: tags('food', 'dessert') })] }));
		const items = (node.hasMenu as { hasMenuItem: Record<string, unknown>[] }).hasMenuItem;
		expect('suitableForDiet' in items[0]).toBe(false);
	});

	test('an optional ("can be made vegan") tag never asserts a diet', () => {
		const node = venueJsonLd(venue({ menu: [item({ tags: tags('vegan?') })] }));
		const items = (node.hasMenu as { hasMenuItem: Record<string, unknown>[] }).hasMenuItem;
		expect('suitableForDiet' in items[0]).toBe(false);
	});
});

describe('venueJsonLdScript', () => {
	test('wraps the graph in an ld+json script tag whose JSON round-trips', () => {
		const html = venueJsonLdScript(venue({ menu: [item({ item_name: 'Latte', price: 4.5 })] }));
		expect(html.startsWith('<script type="application/ld+json">')).toBe(true);
		expect(html.endsWith('</script>')).toBe(true);
		const json = html.slice('<script type="application/ld+json">'.length, -'</script>'.length);
		expect(JSON.parse(json)).toEqual(
			venueJsonLd(venue({ menu: [item({ item_name: 'Latte', price: 4.5 })] }))
		);
	});

	test('escapes < > & so a hostile item name cannot break out of the script tag', () => {
		const html = venueJsonLdScript(
			venue({ menu: [item({ item_name: 'Ramen </script><script>alert(1)</script>' })] })
		);
		// The only real tag boundaries are the wrapping <script>…</script>; the
		// payload's angle brackets are all escaped away.
		expect(html.indexOf('</script>')).toBe(html.length - '</script>'.length);
		expect(html).not.toContain('<script>alert(1)');
		expect(html).toContain('\\u003c');
		// …and the escaped JSON still parses back to the exact original name.
		const json = html.slice('<script type="application/ld+json">'.length, -'</script>'.length);
		const parsed = JSON.parse(json) as { hasMenu: { hasMenuItem: { name: string }[] } };
		expect(parsed.hasMenu.hasMenuItem[0].name).toBe('Ramen </script><script>alert(1)</script>');
	});
});
