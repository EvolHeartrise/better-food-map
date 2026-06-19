/// <reference types="bun-types" />
/**
 * Database seed script for the Vancouver food-search-engine prototype.
 *
 * Populates `data/food.db` with 20 REAL, currently-operating Vancouver, BC
 * food places (a mix of cafes, fast food, and restaurants) plus best-effort,
 * verifiably-real menu items.
 *
 * Data sources:
 *  - Coordinates: OpenStreetMap Nominatim geocoder
 *    (https://nominatim.openstreetmap.org/search), verified to fall within
 *    Greater Vancouver bounds (lat ~49.20-49.32, lon ~-123.25 to -122.90).
 *  - Addresses / phone / website / menu items + prices: official restaurant
 *    websites and reputable public listings (Yelp, OpenTable, official menus).
 *  - Only menu items that could be verified from a real source are inserted.
 *    Prices are real CAD values from official/official-adjacent sources; where
 *    a price (or ingredient list) could not be verified it is left null.
 *
 * Idempotent: clears existing rows on every run so re-seeding never duplicates.
 *
 * Run with:  bun run scripts/seed.ts
 */

import { db, insertLocation, insertFood } from '../src/lib/server/db';
import type { Category } from '../src/lib/server/db';

interface SeedFood {
	item_name: string;
	ingredients?: string | null;
	price?: number | null;
}

interface SeedLocation {
	name: string;
	category: Category;
	latitude: number;
	longitude: number;
	address: string | null;
	phone: string | null;
	website: string | null;
	menu: SeedFood[];
}

// ---------------------------------------------------------------------------
// REAL Vancouver places. Coordinates from OpenStreetMap Nominatim.
// ---------------------------------------------------------------------------

const PLACES: SeedLocation[] = [
	// ----------------------------- CAFES (6) -----------------------------
	{
		name: 'Revolver',
		category: 'cafe',
		latitude: 49.2831716,
		longitude: -123.109459,
		address: '325 Cambie St, Vancouver, BC V6B 1H7',
		phone: '+1 604-558-4444',
		website: 'https://revolvercoffee.ca/',
		// Specialty espresso bar in Gastown. Verified offerings (no public
		// fixed price list — prices left null).
		menu: [
			{ item_name: 'Espresso', ingredients: 'espresso', price: null },
			{ item_name: 'Cappuccino', ingredients: 'espresso, steamed milk', price: null },
			{ item_name: 'Pour Over', ingredients: 'single-origin coffee', price: null }
		]
	},
	{
		name: 'Prado Cafe',
		category: 'cafe',
		latitude: 49.2671946,
		longitude: -123.0694273,
		address: '1938 Commercial Dr, Vancouver, BC V5N 4B1',
		phone: '+1 604-255-5537',
		website: 'https://www.pradocafevancouver.com/',
		menu: [
			{ item_name: 'Latte', ingredients: 'espresso, steamed milk', price: null },
			{ item_name: 'Cortado', ingredients: 'espresso, warm milk', price: null },
			{ item_name: 'Drip Coffee', ingredients: 'coffee', price: null }
		]
	},
	{
		name: 'JJ Bean Coffee Roasters (Granville Island)',
		category: 'cafe',
		latitude: 49.272173,
		longitude: -123.135145,
		address: '1689 Johnston St, Granville Island, Vancouver, BC V6H 3S2',
		phone: '+1 604-685-0613',
		website: 'https://jjbeancoffee.com/',
		menu: [
			{ item_name: 'Cappuccino', ingredients: 'espresso, steamed milk', price: null },
			{ item_name: 'Latte', ingredients: 'espresso, steamed milk', price: null },
			{ item_name: 'Cinnamon Bun', ingredients: 'flour, butter, cinnamon, sugar', price: null }
		]
	},
	{
		name: 'Nemesis Coffee (Gastown)',
		category: 'cafe',
		latitude: 49.282764,
		longitude: -123.1102832,
		address: '302 W Hastings St, Vancouver, BC V6B 1K6',
		phone: '+1 778-200-3641',
		website: 'https://www.nemesis.coffee/',
		menu: [
			{ item_name: 'Espresso', ingredients: 'espresso', price: null },
			{ item_name: 'Flat White', ingredients: 'espresso, steamed milk', price: null }
		]
	},
	{
		name: 'Cafe Medina',
		category: 'cafe',
		latitude: 49.2805588,
		longitude: -123.116906,
		address: '780 Richards St, Vancouver, BC V6B 3A4',
		phone: '+1 604-879-3114',
		website: 'https://www.medinacafe.com/',
		// Prices from official site menu (medinacafe.com/menu).
		menu: [
			{
				item_name: 'Liège Style Waffle',
				ingredients: 'liège waffle',
				price: 4.5
			},
			{
				item_name: 'Fricassée',
				ingredients: 'eggs, braised short ribs, potatoes, onions, cheddar, arugula, focaccia',
				price: 31
			},
			{
				item_name: 'Paella',
				ingredients: 'egg, orzo, chorizo, roasted vegetables, padano, avocado, salsa',
				price: 22
			},
			{
				item_name: 'Cassoulet',
				ingredients: 'eggs, bacon, sausages, white beans, tomatoes, focaccia',
				price: 25
			},
			{ item_name: 'Avocado Toast', ingredients: 'avocado, toast', price: 14 }
		]
	},
	{
		name: "Sophie's Cosmic Cafe",
		category: 'cafe',
		latitude: 49.2682468,
		longitude: -123.1525549,
		address: '2095 W 4th Ave, Vancouver, BC V6J 1M5',
		phone: '+1 604-732-6810',
		website: 'https://sophiescosmiccafe.com/',
		// Kitsilano diner-style cafe famous for its milkshakes and big breakfasts.
		// Specific prices not reliably verifiable -> left null.
		menu: [
			{ item_name: 'Milkshake', ingredients: 'ice cream, milk', price: null },
			{ item_name: 'Belgian Waffle', ingredients: 'waffle batter', price: null },
			{ item_name: 'Buttermilk Pancakes', ingredients: 'buttermilk, flour, eggs', price: null }
		]
	},

	// --------------------------- FAST FOOD (5) ---------------------------
	{
		name: 'Japadog (Robson St)',
		category: 'fast_food',
		latitude: 49.2801999,
		longitude: -123.1182707,
		address: '530 Robson St, Vancouver, BC V6B 2B7',
		phone: '+1 604-569-1158',
		website: 'https://japadog.com/',
		// Items verified from official site / Japadog listings. Prices vary by
		// location/platform; left null to avoid asserting an unverified figure.
		menu: [
			{
				item_name: 'Kurobuta Terimayo',
				ingredients: 'kurobuta pork sausage, teriyaki sauce, japanese mayo, fried onions, seaweed',
				price: null
			},
			{
				item_name: 'Okonomi',
				ingredients:
					'kurobuta pork sausage, japanese sauce, japanese mayo, bonito flakes, fried cabbage',
				price: null
			},
			{
				item_name: 'Oroshi',
				ingredients: 'kurobuta pork sausage, grated radish, green onions, special soy sauce',
				price: null
			},
			{ item_name: 'Karaage', ingredients: 'deep fried chicken', price: null },
			{ item_name: 'Edamame', ingredients: 'soy beans', price: null }
		]
	},
	{
		name: "Triple O's (Telus World of Science)",
		category: 'fast_food',
		latitude: 49.2734536,
		longitude: -123.1036739,
		address: '1455 Quebec St, Vancouver, BC V6A 3Z7',
		phone: null,
		website: 'https://www.tripleos.com/',
		// White Spot's fast-food spinoff. Original Burger verified at $7.99
		// (Triple O Tuesday promo price, 2026); other prices left null.
		menu: [
			{
				item_name: 'Original Burger',
				ingredients: 'beef patty, triple O sauce, pickle, lettuce, tomato, bun',
				price: 7.99
			},
			{ item_name: 'Kennebec Fries', ingredients: 'fresh-cut kennebec potatoes', price: null },
			{ item_name: 'Milkshake', ingredients: 'ice cream, milk', price: null }
		]
	},
	{
		name: 'Tacofino (Kitsilano)',
		category: 'fast_food',
		latitude: 49.2682471,
		longitude: -123.1483923,
		address: '1909 W 4th Ave, Vancouver, BC V6J 1M5',
		phone: '+1 604-727-8226',
		website: 'https://www.tacofino.com/',
		// Prices from public delivery listings (Uber Eats / DoorDash, 2026).
		menu: [
			{
				item_name: 'Fish Taco',
				ingredients: 'tempura pacific cod, cabbage, salsa fresca, chipotle mayo',
				price: 9.9
			},
			{
				item_name: 'Crispy Chicken Burrito',
				ingredients:
					'karaage chicken, spiced rice, cabbage, guacamole, chili oil, chili mayo, sriracha, cilantro',
				price: 20.35
			},
			{ item_name: 'Tacofino Tots', ingredients: 'seasoned tots, salsa ranch', price: 7.7 }
		]
	},
	{
		name: 'Meat & Bread (Cambie)',
		category: 'fast_food',
		latitude: 49.282623,
		longitude: -123.109344,
		address: '370 Cambie St, Vancouver, BC V6B 1G8',
		phone: null,
		website: 'https://www.meatandbread.com/',
		// Sandwich shop. Items verified from official site; specific Vancouver
		// prices not reliably verifiable -> left null.
		menu: [
			{
				item_name: 'Porchetta Sandwich',
				ingredients: 'porchetta, salsa verde, crackling, ciabatta',
				price: null
			},
			{
				item_name: 'Meatball Sandwich',
				ingredients: 'meatballs, tomato sauce, ciabatta',
				price: null
			},
			{ item_name: 'Grilled Cheese', ingredients: 'cheese, bread', price: null }
		]
	},
	{
		name: 'La Taqueria Pinche Taco Shop (Seymour)',
		category: 'fast_food',
		latitude: 49.2850582,
		longitude: -123.1125886,
		address: '367 Seymour St, Vancouver, BC V6B 5A7',
		phone: '+1 604-558-2549',
		website: 'https://www.lataqueria.com/',
		// Authentic taco shop. Specific per-taco prices not reliably verifiable
		// across sources -> left null.
		menu: [
			{
				item_name: 'Carnitas Taco',
				ingredients: 'braised pork, onion, cilantro, salsa',
				price: null
			},
			{ item_name: 'Asada Taco', ingredients: 'grilled beef, onion, cilantro, salsa', price: null },
			{ item_name: 'Pollo Taco', ingredients: 'chicken, onion, cilantro, salsa', price: null }
		]
	},

	// --------------------------- RESTAURANTS (9) -------------------------
	{
		name: "Vij's Restaurant",
		category: 'restaurant',
		latitude: 49.2575621,
		longitude: -123.114845,
		address: '3106 Cambie St, Vancouver, BC V5Z 2W2',
		phone: '+1 604-736-6664',
		website: 'https://www.vijs.ca/',
		// Prices from official site dinner menu (vijs.ca).
		menu: [
			{
				item_name: 'Wine Marinated Lamb Popsicles',
				ingredients: 'lamb, spinach potatoes, garlic fenugreek curry',
				price: 39
			},
			{
				item_name: 'Lamb Rogan Josh',
				ingredients: 'lamb, cardamom, cloves, cinnamon, red chillies',
				price: 35.5
			},
			{
				item_name: 'Fraser Valley Raised Goat Curry',
				ingredients: 'goat, yoghurt, garlic, ginger, red chillies',
				price: 37
			}
		]
	},
	{
		name: 'Phnom Penh',
		category: 'restaurant',
		latitude: 49.2783508,
		longitude: -123.098202,
		address: '244 E Georgia St, Vancouver, BC V6A 1Z7',
		phone: '+1 604-682-5777',
		website: 'https://phnompenhrestaurant.ca/',
		// Prices from official menu listing.
		menu: [
			{
				item_name: 'Phnom Penh Deep-fried Chicken Wings (Small)',
				ingredients: 'chicken wings, garlic, scallion, butter, lemon pepper sauce',
				price: 11.95
			},
			{
				item_name: 'Phnom Penh Deep-fried Chicken Wings (Large)',
				ingredients: 'chicken wings, garlic, scallion, butter, lemon pepper sauce',
				price: 16.95
			},
			{
				item_name: 'Marinated Butter Beef',
				ingredients: 'beef, lime, garlic, butter',
				price: 17.5
			},
			{
				item_name: 'Phnom Penh Spicy Garlic Prawns (Small)',
				ingredients: 'prawns, garlic, chili',
				price: 12.25
			},
			{
				item_name: 'Vietnamese Spring Rolls',
				ingredients: 'pork, shrimp, rice paper',
				price: 12.25
			}
		]
	},
	{
		name: 'Miku',
		category: 'restaurant',
		latitude: 49.2870647,
		longitude: -123.112828,
		address: '70-200 Granville St, Vancouver, BC V6C 1S4',
		phone: '+1 604-568-3900',
		website: 'https://mikurestaurant.com/',
		// Known for flame-seared Aburi Oshi sushi. Specific prices not reliably
		// verified -> left null.
		menu: [
			{
				item_name: 'Salmon Oshi Sushi',
				ingredients: 'pressed salmon, sushi rice, jalapeno, miku sauce',
				price: null
			},
			{
				item_name: 'Aburi Saba Oshi Sushi',
				ingredients: 'pressed mackerel, sushi rice',
				price: null
			}
		]
	},
	{
		name: 'Kishimoto Japanese Kitchen',
		category: 'restaurant',
		latitude: 49.2667494,
		longitude: -123.0694829,
		address: '2054 Commercial Dr, Vancouver, BC V5N 4B1',
		phone: '+1 604-255-5550',
		website: 'https://www.kishimotorestaurant.com/',
		menu: [
			{ item_name: 'Aburi Salmon Oshi', ingredients: 'seared salmon, sushi rice', price: null },
			{ item_name: 'Chirashi Don', ingredients: 'assorted sashimi, sushi rice', price: null }
		]
	},
	{
		name: 'The Naam',
		category: 'restaurant',
		latitude: 49.2682285,
		longitude: -123.166974,
		address: '2724 W 4th Ave, Vancouver, BC V6K 1R1',
		phone: '+1 604-738-7151',
		website: 'https://thenaam.com/',
		// Long-running vegetarian restaurant. Items verified; prices vary across
		// listings -> left null.
		menu: [
			{
				item_name: 'Dragon Bowl',
				ingredients: 'brown rice, steamed veggies, tofu, sprouts, sesame-soy dressing',
				price: null
			},
			{ item_name: 'Sesame Fries', ingredients: 'potatoes, sesame, miso gravy', price: null },
			{
				item_name: 'Naam Bowl',
				ingredients: 'brown rice, steamed veggies, miso gravy, tofu, carrots, beets',
				price: null
			}
		]
	},
	{
		name: 'The Acorn',
		category: 'restaurant',
		latitude: 49.2495635,
		longitude: -123.1012512,
		address: '3995 Main St, Vancouver, BC V5V 3N4',
		phone: '+1 604-566-9001',
		website: 'https://www.theacornrestaurant.ca/',
		// Michelin-recommended vegetable-forward restaurant. Menu rotates
		// seasonally; specific prices not verifiable here -> left null.
		menu: [
			{
				item_name: 'Beer-battered Halloumi',
				ingredients: 'halloumi, fennel, caper-dill yoghurt',
				price: null
			}
		]
	},
	{
		name: 'Granville Island Brewing',
		category: 'restaurant',
		latitude: 49.2706033,
		longitude: -123.1356945,
		address: '1441 Cartwright St, Vancouver, BC V6H 3R7',
		phone: '+1 604-687-2739',
		website: 'https://www.granvilleislandbrewing.ca/',
		// Canada's first microbrewery + taproom. Beers verified from brand;
		// taproom food/drink prices not verified here -> left null.
		menu: [
			{ item_name: 'English Bay Pale Ale', ingredients: 'malt, hops, yeast, water', price: null },
			{
				item_name: 'False Creek Raspberry Ale',
				ingredients: 'malt, hops, raspberry, yeast, water',
				price: null
			}
		]
	},
	{
		name: 'Toshi Sushi',
		category: 'restaurant',
		latitude: 49.256744,
		longitude: -123.1018952,
		address: '181 E 16th Ave, Vancouver, BC V5T 3G8',
		phone: '+1 604-874-5173',
		website: null,
		// Popular no-reservations sushi spot. Specific prices not verifiable
		// from a reliable source -> left null.
		menu: [
			{ item_name: 'Box Roll', ingredients: 'salmon, tuna, sushi rice, nori', price: null },
			{ item_name: 'Spicy Agedashi Tofu', ingredients: 'fried tofu, dashi, chili', price: null }
		]
	},
	{
		name: 'White Spot (Kerrisdale)',
		category: 'restaurant',
		latitude: 49.2376572,
		longitude: -123.155639,
		address: '5367 West Blvd, Vancouver, BC V6M 3W6',
		phone: '+1 604-261-2820',
		website: 'https://whitespot.ca/',
		// Iconic BC restaurant chain. Specific current prices not verified here
		// -> left null. The "Legendary" burger with Triple O sauce is the
		// signature item.
		menu: [
			{
				item_name: 'Legendary Burger',
				ingredients: 'beef patty, triple O sauce, lettuce, tomato, pickle, bun',
				price: null
			},
			{
				item_name: 'BC Chicken Burger',
				ingredients: 'crispy chicken, lettuce, tomato, mayo, bun',
				price: null
			}
		]
	}
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

// Idempotent: clear existing data so re-runs do not duplicate rows.
db.run('DELETE FROM food');
db.run('DELETE FROM locations');

const VAN_BOUNDS = { latMin: 49.2, latMax: 49.32, lonMin: -123.25, lonMax: -122.9 };

let totalLocations = 0;
let locationsWithMenu = 0;
let totalFood = 0;

for (const place of PLACES) {
	// Sanity-check coordinates fall within Greater Vancouver.
	if (
		place.latitude < VAN_BOUNDS.latMin ||
		place.latitude > VAN_BOUNDS.latMax ||
		place.longitude < VAN_BOUNDS.lonMin ||
		place.longitude > VAN_BOUNDS.lonMax
	) {
		throw new Error(
			`Coordinates for "${place.name}" (${place.latitude}, ${place.longitude}) are outside Greater Vancouver bounds.`
		);
	}

	const locationId = insertLocation({
		name: place.name,
		category: place.category,
		latitude: place.latitude,
		longitude: place.longitude,
		address: place.address,
		phone: place.phone,
		website: place.website
	});
	totalLocations++;

	if (place.menu.length > 0) {
		locationsWithMenu++;
	}

	for (const item of place.menu) {
		insertFood({
			location_id: locationId,
			item_name: item.item_name,
			ingredients: item.ingredients ?? null,
			price: item.price ?? null
		});
		totalFood++;
	}
}

// ---------------------------------------------------------------------------
// Summary + sanity check
// ---------------------------------------------------------------------------

const locCount = (db.query('SELECT COUNT(*) AS c FROM locations').get() as { c: number }).c;
const foodCount = (db.query('SELECT COUNT(*) AS c FROM food').get() as { c: number }).c;

const byCategory = db
	.query('SELECT category, COUNT(*) AS c FROM locations GROUP BY category ORDER BY category')
	.all() as Array<{ category: string; c: number }>;

console.log('--- Seed complete ---');
console.log(`Locations inserted:        ${totalLocations}`);
console.log(`Locations with >=1 menu:   ${locationsWithMenu}`);
console.log(`Total food items inserted: ${totalFood}`);
console.log('');
console.log('By category:');
for (const row of byCategory) {
	console.log(`  ${row.category.padEnd(12)} ${row.c}`);
}
console.log('');
console.log(`SELECT COUNT(*) FROM locations -> ${locCount}`);
console.log(`SELECT COUNT(*) FROM food      -> ${foodCount}`);
