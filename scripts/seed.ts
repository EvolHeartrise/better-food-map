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
import type { Category, TagId } from '../src/lib/server/db';

interface SeedFood {
	item_name: string;
	description?: string | null;
	ingredients?: string | null;
	price?: number | null;
	// Dietary tags, curated conservatively from the listed ingredients only.
	// Rules of thumb used below:
	//   - vegan      → only plant-based ingredients (no meat, fish, dairy, egg)
	//   - vegetarian → no meat or fish (vegan implies vegetarian)
	//   - gluten_free→ no bread/bun/flour/batter/breading/wheat noodles
	//   - dairy_free → no milk/cheese/butter/cream/yoghurt/ice cream
	//   - nut_free   → no tree nuts/peanuts in the listed ingredients
	//   - halal      → ONLY certified-halal items/venues (never inferred from
	//                  "plant-based / pork-free / alcohol-free")
	// These are best-effort and informational — see the disclaimer in the UI.
	tags?: TagId[];
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
			{
				item_name: 'Espresso',
				ingredients: 'espresso',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Cappuccino',
				ingredients: 'espresso, steamed milk',
				price: null,
				tags: ['vegetarian', 'gluten_free', 'nut_free']
			},
			{
				item_name: 'Pour Over',
				ingredients: 'single-origin coffee',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			}
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
			{
				item_name: 'Latte',
				ingredients: 'espresso, steamed milk',
				price: null,
				tags: ['vegetarian', 'gluten_free', 'nut_free']
			},
			{
				item_name: 'Cortado',
				ingredients: 'espresso, warm milk',
				price: null,
				tags: ['vegetarian', 'gluten_free', 'nut_free']
			},
			{
				item_name: 'Drip Coffee',
				ingredients: 'coffee',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			}
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
			{
				item_name: 'Cappuccino',
				ingredients: 'espresso, steamed milk',
				price: null,
				tags: ['vegetarian', 'gluten_free', 'nut_free']
			},
			{
				item_name: 'Latte',
				ingredients: 'espresso, steamed milk',
				price: null,
				tags: ['vegetarian', 'gluten_free', 'nut_free']
			},
			{
				item_name: 'Cinnamon Bun',
				ingredients: 'flour, butter, cinnamon, sugar',
				price: null,
				tags: ['vegetarian', 'nut_free']
			}
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
			{
				item_name: 'Espresso',
				ingredients: 'espresso',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Flat White',
				ingredients: 'espresso, steamed milk',
				price: null,
				tags: ['vegetarian', 'gluten_free', 'nut_free']
			}
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
				price: 4.5,
				tags: ['vegetarian']
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
			{
				item_name: 'Avocado Toast',
				ingredients: 'avocado, toast',
				price: 14,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			}
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
			{
				item_name: 'Milkshake',
				ingredients: 'ice cream, milk',
				price: null,
				tags: ['vegetarian', 'gluten_free', 'nut_free']
			},
			{
				item_name: 'Belgian Waffle',
				ingredients: 'waffle batter',
				price: null,
				tags: ['vegetarian']
			},
			{
				item_name: 'Buttermilk Pancakes',
				ingredients: 'buttermilk, flour, eggs',
				price: null,
				tags: ['vegetarian', 'nut_free']
			}
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
			{
				item_name: 'Edamame',
				ingredients: 'soy beans',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			}
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
			{
				item_name: 'Kennebec Fries',
				ingredients: 'fresh-cut kennebec potatoes',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Milkshake',
				ingredients: 'ice cream, milk',
				price: null,
				tags: ['vegetarian', 'gluten_free', 'nut_free']
			}
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
			{
				item_name: 'Tacofino Tots',
				ingredients: 'seasoned tots, salsa ranch',
				price: 7.7,
				tags: ['vegetarian', 'nut_free']
			}
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
			{
				item_name: 'Grilled Cheese',
				ingredients: 'cheese, bread',
				price: null,
				tags: ['vegetarian', 'nut_free']
			}
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
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free'],
				price: null
			},
			{
				item_name: 'Sesame Fries',
				ingredients: 'potatoes, sesame, miso gravy',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Naam Bowl',
				ingredients: 'brown rice, steamed veggies, miso gravy, tofu, carrots, beets',
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free'],
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
				tags: ['vegetarian', 'nut_free'],
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
			{
				item_name: 'English Bay Pale Ale',
				ingredients: 'malt, hops, yeast, water',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'False Creek Raspberry Ale',
				ingredients: 'malt, hops, raspberry, yeast, water',
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free'],
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
	},

	// --------------------- VEGETARIAN / VEGAN (8) ---------------------
	{
		name: 'MeeT on Main',
		category: 'restaurant',
		latitude: 49.2467312,
		longitude: -123.1008547,
		address: '4288 Main St, Vancouver, BC V5V 3P9',
		phone: '+1 604-696-1010',
		website: 'https://eatmeet.ca/',
		// Fully-vegan comfort-food restaurant on Main St (original MeeT
		// location). Items verified from official site / menu listings;
		// specific prices vary across platforms -> left null.
		menu: [
			{
				item_name: 'Mac N Cheez Bowl',
				ingredients: 'macaroni, cashew cheez sauce, breadcrumbs',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'Crispy BBQ Burger',
				ingredients:
					'battered soy patty, whiskey bbq sauce, crispy onion strings, chao cheez, chipotle mayo, bun',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'Oyster Mushroom Kalamari',
				ingredients: 'battered oyster mushrooms, lemon, vegan aioli',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Poutine',
				ingredients: 'fries, mushroom gravy, vegan cheez curds',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			}
		]
	},
	{
		name: 'Chau Veggie Express',
		category: 'restaurant',
		latitude: 49.2727362,
		longitude: -123.1352818,
		address: '1689 Johnston St, Granville Island, Vancouver, BC V6H 3S2',
		phone: '+1 778-379-9508',
		website: 'https://www.chau-veggiexpress.com/',
		// Family-run vegan Vietnamese eatery (Granville Island). Ingredients
		// verified from official/listed menus; prices not reliably verifiable
		// across platforms -> left null.
		menu: [
			{
				item_name: 'Golden Temple Soup',
				ingredients:
					'turmeric coconut curry broth, seasonal vegetables, beancurd, mushrooms, taro, yam, kale',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Midnight Swim Bowl',
				ingredients:
					'brown rice, lentils, spicy peanut garlic soy mushroom sauce, tofu, mushrooms, beancurd, kale, mung beans, peanuts',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'Sapa Power Salad',
				ingredients: 'seasonal greens, vegetables, lemongrass citrus dressing',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Nonla Crispy Rolls',
				ingredients: 'taro, jicama, carrot, rice paper, vegan dipping sauce',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			}
		]
	},
	{
		name: 'Virtuous Pie (Main St)',
		category: 'restaurant',
		latitude: 49.2796992,
		longitude: -123.099992,
		address: '583 Main St, Vancouver, BC V6A 2V1',
		phone: '+1 604-620-0060',
		website: 'https://www.virtuouspie.com/',
		// 100% plant-based pizzeria. Ingredients + prices from the official
		// Vancouver menu (virtuouspie.com/vancouver).
		menu: [
			{
				item_name: 'Margherita',
				ingredients: 'san marzano tomato sauce, cashew mozzarella, parmesan, basil',
				price: 22,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'Stranger Wings',
				ingredients:
					'bianca sauce, spicy buffalo cauliflower, fried shallots, blue cheese, scallion',
				price: 24,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Superfunghi',
				ingredients:
					'cashew mozzarella, herbed potato cream, truffle almond ricotta, wild mushrooms, arugula',
				price: 26,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'Garlic Knots',
				ingredients: 'dough, spicy garlic, parmesan, parsley',
				price: 12,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			}
		]
	},
	{
		name: 'The Burrow (formerly Bandidas Taqueria)',
		category: 'restaurant',
		latitude: 49.2597756,
		longitude: -123.070086,
		address: '2781 Commercial Dr, Vancouver, BC V5N 4C7',
		phone: '+1 604-568-8224',
		website: 'https://theburrowrestaurant.com/',
		// Long-running vegetarian (vegan-friendly) Mexican spot on Commercial
		// Dr, rebranded from Bandidas Taqueria. Items verified from official
		// site / listings; per-item prices vary -> left null.
		menu: [
			{
				item_name: 'Baked Burrito',
				ingredients: 'flour tortilla, refried beans, rice, cheese, salsa, sour cream',
				price: null,
				tags: ['vegetarian', 'nut_free']
			},
			{
				item_name: 'Nachos',
				ingredients: 'corn tortilla chips, cheese, spicy corn, jalapenos, salsa, sour cream',
				price: null,
				tags: ['vegetarian', 'gluten_free', 'nut_free']
			},
			{
				item_name: 'Chipotle Tofu Quesadilla',
				ingredients: 'corn tortilla, cheese, smoky chipotle tofu',
				price: null,
				tags: ['vegetarian', 'gluten_free', 'nut_free']
			},
			{
				item_name: 'Chips & Guacamole',
				ingredients: 'corn tortilla chips, avocado, lime, onion, cilantro',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			}
		]
	},
	{
		name: 'Nuba in Gastown',
		category: 'restaurant',
		latitude: 49.2827611,
		longitude: -123.109648,
		address: '207 W Hastings St, Vancouver, BC V6B 1H7',
		phone: '+1 604-688-1655',
		website: 'https://www.nuba.ca/',
		// Lebanese restaurant with a large vegan + gluten-free selection.
		// Vegetarian/vegan items tagged below from the official menu (nuba.ca).
		// Prices vary across listings -> left null.
		menu: [
			{
				item_name: 'Najib Special',
				ingredients: 'crispy cauliflower, lemon, sea salt',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Falafel Plate',
				ingredients: 'chickpeas, fava beans, vegetables, spices, hummus, salad, pickled cabbage',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Hummus',
				ingredients: 'chickpeas, garlic, lemon, tahini',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Mujadara',
				ingredients: 'green lentils, brown rice, onions, jalapeno',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Tabbouleh',
				ingredients: 'parsley, tomato, red onion, bulgur, lemon mint vinaigrette',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			}
		]
	},
	{
		name: 'Eternal Abundance',
		category: 'cafe',
		latitude: 49.2752619,
		longitude: -123.0699132,
		address: '1025 Commercial Dr, Vancouver, BC V5L 3X1',
		phone: '+1 604-707-0088',
		website: 'https://eternalabundance.ca/',
		// Organic, all-vegan market + raw-friendly cafe on Commercial Dr. Items
		// verified from official cafe menu; prices not reliably verifiable
		// across listings -> left null.
		menu: [
			{
				item_name: 'Incredi-bowl',
				ingredients:
					'greens, vegetables, warm grain, avocado, smoked tofu, turmeric sesame dressing, sauerkraut',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Raw Mushroom Burger',
				ingredients: 'mushroom seed patty, fresh vegetables, sprouts, collard leaf',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free']
			},
			{
				item_name: 'Refried Bean Burrito',
				ingredients: 'gluten-free wrap, refried pinto beans, guacamole, vegetables',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Sunflower Cheeze Wrap',
				ingredients:
					'gluten-free bread, sunflower dill cheeze, red onion, avocado, alfalfa sprouts',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			}
		]
	},
	{
		name: 'Chickpea',
		category: 'restaurant',
		latitude: 49.2466017,
		longitude: -123.1009589,
		address: '4298 Main St, Vancouver, BC V5V 3P9',
		phone: '+1 604-620-0639',
		website: 'https://www.ilovechickpea.ca/',
		// Fully-vegan Israeli / Mediterranean restaurant on Main St. Full menu
		// (food + non-alcoholic drinks) transcribed from the official site
		// (ilovechickpea.ca), June 2026. Prices exclude GST/liquor tax; alcoholic
		// drinks (cocktails, beer, wine) are intentionally not listed here.
		menu: [
			// --- Chickpea Tapas (sizes: Small / Medium / Large; price shown is Small) ---
			{
				item_name: 'Hummus',
				description:
					'Chickpeas sprinkled with olive oil, zaatar, paprika & parsley. Small $5 / Medium $8 / Large $12.',
				ingredients: 'chickpeas, tahini, olive oil, zaatar, paprika, parsley',
				price: 5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Chickpea Fries',
				description:
					'Crispy, gluten free & packed with protein. Small $7 / Medium $11 / Large $15.',
				ingredients: 'chickpea flour, olive oil, salt',
				price: 7,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'House Salad',
				description:
					'Mixed spring greens with tomatoes, cucumbers, pickled turnips & crispy chickpeas. Small $5 / Medium $8 / Large $12.',
				ingredients: 'spring greens, tomatoes, cucumbers, pickled turnips, crispy chickpeas',
				price: 5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Red Beet Salad',
				description:
					'Marinated, shredded beets garnished with parsley. Small $4 / Medium $7.50 / Large $11.',
				ingredients: 'beets, vinaigrette, parsley',
				price: 4,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Baba Ganoush',
				description:
					'Smoky eggplant blended with vegan mayo, olive oil, lemon juice & Mediterranean spices. Small $5.50 / Medium $10 / Large $14.',
				ingredients: 'roasted eggplant, vegan mayo, olive oil, lemon, spices',
				price: 5.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Pickled Veggies',
				description:
					'Pepperoncini, cauliflower, crunchy carrots, celery, cabbage & garlic. Small $4 / Medium $8 / Large $12.',
				ingredients: 'pepperoncini, cauliflower, carrots, celery, cabbage, garlic',
				price: 4,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Cabbage Salad',
				description:
					'Shredded white cabbage dressed with soy sauce & roasted sesame seeds. Small $4 / Medium $7.50 / Large $11.',
				ingredients: 'white cabbage, soy sauce, sesame seeds',
				price: 4,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Labaneh',
				description:
					'House-made coconut cream cheese drizzled with house-made hot sauce. Small $6 / Medium $10.50 / Large $14.50.',
				ingredients: 'coconut cream cheese, hot sauce',
				price: 6,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Marinated Cucumbers',
				description:
					'Tangy cucumbers with dill & red onions, marinated in a special vinaigrette. Small $4 / Medium $7.50 / Large $11.',
				ingredients: 'cucumbers, dill, red onions, vinaigrette',
				price: 4,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Hatzilim',
				description:
					'Sliced, sautéed eggplant marinated with paprika, cumin, garlic & lemon. Small $4.50 / Medium $8.50 / Large $12.50.',
				ingredients: 'eggplant, paprika, cumin, garlic, lemon',
				price: 4.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Moroccan Carrots',
				description:
					'Carrots spiked with lemon, garlic, cumin, paprika & parsley. Small $4.50 / Medium $8.50 / Large $10.',
				ingredients: 'carrots, lemon, garlic, cumin, paprika, parsley',
				price: 4.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Turmeric Rice',
				description: 'Fragrant rice cooked with turmeric. Small $5 / Medium $8 / Large $12.',
				ingredients: 'rice, turmeric',
				price: 5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Zaatar French Fries',
				description: 'French fries tossed with zaatar. Small $6 / Medium $10 / Large $14.',
				ingredients: 'potatoes, zaatar, salt',
				price: 6,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},

			// --- Mains: each served in your choice of format (wrap/pita $17.50, salad or
			// rice bowl $21, hummus plate $23, rice platter $24, platter $26, hafla $42pp).
			// Listed price is the wrap/pita base, including any per-main surcharge. ---
			{
				item_name: 'Falafel',
				description:
					'A special mix of chickpeas, parsley, onions, garlic & secret spices fried to perfection, with a slice of crunchy eggplant.',
				ingredients: 'chickpeas, parsley, onions, garlic, spices, eggplant',
				price: 17.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'ChickSteak',
				description:
					'Flakes of vegan steak & sautéed onions, well seasoned & cooked to perfection.',
				ingredients: 'vegan steak, onions, spices',
				price: 19.5,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Kasum',
				description:
					'Crispy fried cauliflower, sautéed turmeric-covered mushrooms & onions with lemon-garlic sauce.',
				ingredients: 'cauliflower, mushrooms, onions, turmeric, lemon garlic sauce',
				price: 17.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Dalorit',
				description:
					'Roasted butternut squash baked with oregano, rosemary oil & paprika, drizzled with tahini & parsley.',
				ingredients: 'butternut squash, oregano, rosemary oil, paprika, tahini, parsley',
				price: 17.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Shawarma',
				description:
					'Soy curls & sautéed onions marinated in an exotic spice blend with hints of curry, sumac & coriander.',
				ingredients: 'soy curls, onions, curry, sumac, coriander',
				price: 17.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Calamachick',
				description:
					'Oyster mushrooms deep-fried in cayenne tempura batter with tzatziki & parsley.',
				ingredients: 'oyster mushrooms, cayenne tempura batter, tzatziki, parsley',
				price: 17.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Shnitzelonim',
				description:
					'Crispy breaded smoked tofu coated with Toscana spices & gluten-free crumbs, with sliced yams & avocado.',
				ingredients: 'smoked tofu, toscana spices, gluten-free crumbs, yams, avocado',
				price: 17.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Chickebab',
				description:
					'Baharat & sumac spiced plant-based ground meat with parsley & mint, shaped into bite-sized patties.',
				ingredients: 'plant-based ground meat, baharat, sumac, parsley, mint',
				price: 18.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Sabich',
				description: 'Flawlessly fried, crunchy eggplant & sliced yams.',
				ingredients: 'eggplant, yams',
				price: 17.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: "Truffled N'Oyster",
				description:
					'Sautéed oyster mushrooms & onions laced with truffle oil & garnished with parsley.',
				ingredients: 'oyster mushrooms, onions, truffle oil, parsley',
				price: 17.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Hatzil Baladi',
				description:
					'Half an eggplant flame-charred until silky & smoky, with lemon-garlic sauce & tahini.',
				ingredients: 'eggplant, lemon garlic sauce, tahini',
				price: 17.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Cauliflower of Life',
				description:
					'A mountain of melt-in-your-mouth roasted cauliflower with olive oil, parsley, mint, tomatoes & red onions.',
				ingredients: 'cauliflower, olive oil, parsley, mint, tomatoes, red onions',
				price: 19,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: "Lion's Mane Steak",
				description:
					"Locally grown lion's mane mushrooms grilled with Chickpea's special steak rub.",
				ingredients: "lion's mane mushrooms, steak rub",
				price: 18.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: "Crispy Chik'n",
				description: "Ultra-crispy Swap Chik'n coated in a signature Toscana spice blend.",
				ingredients: "crispy chik'n, toscana spices",
				price: 18.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},

			// --- Burgers (served with salad & fries) ---
			{
				item_name: 'The Apex Burger',
				description:
					'Smokey burger patty stuffed with nutty mozzarella, slathered in BBQ sauce & topped with vegan bacon & onion rings.',
				ingredients: 'burger patty, nutty mozzarella, bbq sauce, vegan bacon, onion rings, bun',
				price: 26,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'Spicy Halloumi',
				description:
					"Deep-fried almond halloumi 'cheese' with sautéed oyster mushrooms, truffle oil & spicy harissa mayo.",
				ingredients: 'almond halloumi, oyster mushrooms, truffle oil, harissa mayo, bun',
				price: 24,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: "Big Ol' Burger",
				description:
					"Crispy chick'n burger smothered with 'cheese', topped with onion rings, lettuce, tomato & chipotle mayo.",
				ingredients:
					"crispy chik'n, vegan cheese, onion rings, lettuce, tomato, chipotle mayo, bun",
				price: 23,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Ke-Bah-Burg',
				description:
					'The famous Chickebab patty topped with crispy fried onions & a generous dollop of tzatziki.',
				ingredients: 'chickebab patty, fried onions, tzatziki, bun',
				price: 23,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Calamachick Burger',
				description:
					'Oyster mushrooms deep-fried in cayenne tempura batter, slathered in tzatziki & a dash of parsley.',
				ingredients: 'oyster mushrooms, cayenne tempura batter, tzatziki, parsley, bun',
				price: 23,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},

			// --- Tacos & Nachos ---
			{
				item_name: 'Chickpea Tacos',
				description:
					'Two wheat tortillas filled with white cabbage coleslaw & mint-tomato salsa, drizzled with chipotle mayo, garnished with pickled red onions & cilantro.',
				ingredients:
					'wheat tortillas, cabbage coleslaw, mint-tomato salsa, chipotle mayo, pickled red onions, cilantro',
				price: 24,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Chickpea Nachos',
				description:
					'A pile of corn tortilla chips stacked with coconut mozzarella, smoked tofu, pepperoncini, fresh salsa & cilantro, drizzled with chipotle mayo & topped with pickled onions.',
				ingredients:
					'corn tortilla chips, coconut mozzarella, smoked tofu, pepperoncini, salsa, cilantro, chipotle mayo, pickled onions',
				price: 25,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},

			// --- All-Day Breakfast ---
			{
				item_name: 'Hash',
				description:
					'Homefries fried & toasted with paprika, topped with your choice of Main & egg, slathered in famous cashew hollandaise. Served with a side salad.',
				ingredients: 'homefries, paprika, cashew hollandaise, tofu egg',
				price: 22,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'Shakshuka',
				description:
					'Tangy tomato sauce with Mediterranean spices, garlic, onions, carrots, jalapeño & bell peppers, topped with your choice of Main & egg & cashew hollandaise. Served with salad & pita.',
				ingredients:
					'tomato sauce, garlic, onions, carrots, jalapeno, bell peppers, cashew hollandaise, pita',
				price: 23,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'Sandwich',
				description:
					'Your choice of Main with lettuce, tomato & red onion on toasted French bread. Served with salad & homefries.',
				ingredients: 'french bread, lettuce, tomato, red onion, homefries',
				price: 23,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Malawach',
				description:
					'A thick, savoury puff pastry generously stuffed with your choice of Main & egg. Served with salad & homefries.',
				ingredients: 'puff pastry, tofu egg, homefries',
				price: 24,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Breakfast Platter',
				description: 'Your choice of Main & egg, served with a pita, salad & homefries.',
				ingredients: 'tofu egg, pita, salad, homefries',
				price: 25,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Latkes Benechick',
				description:
					'Crispy potato, zucchini & dill fritters piled with your choice of Main & egg, slathered in cashew hollandaise. Served with house salad.',
				ingredients: 'potato, zucchini, dill fritters, tofu egg, cashew hollandaise',
				price: 26,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'The Chickcheese Sandwich',
				description:
					'Eggplant, sliced yams, sun-dried tomato paste, zaatar, pepperoncini, salsa, red schug & vegan cheese grilled between thick slices of bread.',
				ingredients:
					'eggplant, yams, sun-dried tomato paste, zaatar, pepperoncini, salsa, red schug, vegan cheese, bread',
				price: 23,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'The Sweet Waffle',
				description:
					'Two thick almond-milk waffles with bananas, strawberries & coconut whipped cream, drizzled with blueberry sauce & Canadian maple syrup.',
				ingredients:
					'almond milk waffles, bananas, strawberries, coconut whipped cream, blueberry sauce, maple syrup',
				price: 22,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'The Shnitzel Waffle Benechick',
				description:
					'Smoked shnitzelonim on a fluffy waffle with tofu egg, cashew hollandaise & Canadian maple syrup. Served with homefries & house salad.',
				ingredients: 'smoked tofu, waffle, tofu egg, cashew hollandaise, maple syrup, homefries',
				price: 24,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'Blueberry Oat Pancakes',
				description:
					'Almond-milk pancakes made with blueberries, bananas & gluten-free oat flour, drizzled with maple syrup, dusted with powdered sugar & served with coconut whipped cream.',
				ingredients:
					'gluten-free oat flour, almond milk, blueberries, bananas, maple syrup, coconut whipped cream',
				price: 22,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free']
			},
			{
				item_name: 'French Toast',
				description:
					'Bread soaked in maple syrup, almond milk & organic sugar, pan-fried crispy, topped with sautéed cinnamon bananas & coconut whipped cream.',
				ingredients:
					'bread, maple syrup, almond milk, sugar, bananas, cinnamon, coconut whipped cream',
				price: 22,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},

			// --- Desserts ---
			{
				item_name: 'I Love You A-Choco-Lot Mousse',
				description:
					'Creamy chocolate mousse topped with house-made coco whip, strawberries & a thin crunchy cookie.',
				ingredients: 'chocolate mousse, coconut whip, strawberries, cookie',
				price: 12,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Lumberjack Baklava',
				description:
					'Layers of flaky pastry filled with chopped nuts, drizzled with Canadian maple syrup & cinnamon, with caramelized bananas & toasted walnut ice cream.',
				ingredients: 'pastry, nuts, maple syrup, cinnamon, bananas, walnut ice cream',
				price: 12,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'Fairy Baklava',
				description:
					'Layers of flaky pastry filled with chopped nuts, drizzled with orange blossom & rosewater syrup, dusted with cardamom & paired with coconut vanilla ice cream.',
				ingredients: 'pastry, nuts, orange blossom, rosewater syrup, cardamom, coconut ice cream',
				price: 12,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},
			{
				item_name: 'Ice Cream',
				description:
					'House-made vegan ice cream. One scoop $5 / two scoops $9. Flavours: chocolate, vanilla or maple walnut.',
				ingredients: 'vegan ice cream',
				price: 5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free']
			},
			{
				item_name: 'Milkshake',
				description: 'House-made vegan milkshake in chocolate or vanilla.',
				ingredients: 'vegan ice cream, plant milk',
				price: 12,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: "Safta's Secret Carrot Cake",
				description:
					'A moist, richly spiced carrot cake from a secret family recipe, served with house-made coconut whipped cream.',
				ingredients: 'carrot cake, coconut whipped cream',
				price: 10.5,
				tags: ['vegan', 'vegetarian', 'dairy_free']
			},

			// --- Coffee & Tea ---
			{
				item_name: 'Drip Coffee',
				description: null,
				ingredients: 'coffee',
				price: 3.25,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Espresso',
				description: null,
				ingredients: 'espresso',
				price: 3.9,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Americano',
				description: null,
				ingredients: 'espresso, water',
				price: 4.25,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Cappuccino',
				description: 'Made with your choice of plant milk.',
				ingredients: 'espresso, plant milk',
				price: 5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free']
			},
			{
				item_name: 'Flat White',
				description: 'Made with your choice of plant milk.',
				ingredients: 'espresso, plant milk',
				price: 5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free']
			},
			{
				item_name: 'Latte',
				description: 'Made with your choice of plant milk.',
				ingredients: 'espresso, plant milk',
				price: 5.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free']
			},
			{
				item_name: 'London Fog',
				description: 'Earl grey tea steamed with plant milk & vanilla.',
				ingredients: 'earl grey tea, plant milk, vanilla',
				price: 5.95,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free']
			},
			{
				item_name: 'Chai Latte',
				description: 'Spiced chai with your choice of plant milk.',
				ingredients: 'chai, plant milk',
				price: 5.95,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free']
			},
			{
				item_name: 'Dirty Chai',
				description: 'Chai latte with a shot of espresso.',
				ingredients: 'chai, espresso, plant milk',
				price: 6.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free']
			},
			{
				item_name: 'Matcha Latte',
				description: 'Matcha with your choice of plant milk.',
				ingredients: 'matcha, plant milk',
				price: 6,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free']
			},
			{
				item_name: 'Turkish Coffee',
				description: null,
				ingredients: 'coffee, cardamom',
				price: 4.75,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Chicktea',
				description: 'A soothing blend of fresh mint, ginger & lemon.',
				ingredients: 'mint, ginger, lemon',
				price: 4.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'House-made Hot Chocolate',
				description: 'Made with your choice of plant milk.',
				ingredients: 'cocoa, plant milk',
				price: 5.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free']
			},
			{
				item_name: 'Loose Leaf Tea',
				description:
					'Choice of jasmine green dragon, peppermint, English breakfast, berry hibiscus, bergamot cream, turmeric ginger, cardamom rose, chai rooibos, cacao cardamom or pineapple oolong.',
				ingredients: null,
				price: 4.25,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},

			// --- Cold Drinks ---
			{
				item_name: 'Lemonade',
				description: 'House lemonade, limonana (mint) or hibiscus. $6.50 glass / $18 pitcher.',
				ingredients: 'lemon, sugar, water',
				price: 6.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Kefir Brew on Tap',
				description: 'House-made water kefir, on tap.',
				ingredients: 'water kefir',
				price: 7,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Kombucha',
				description: null,
				ingredients: 'kombucha',
				price: 7,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Orange Juice',
				description: null,
				ingredients: 'orange juice',
				price: 5.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Fresh Juice',
				description: 'Beet-ginger-carrot or orange-carrot-ginger.',
				ingredients: 'beet, ginger, carrot, orange',
				price: 9,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Ginger Beer',
				description: null,
				ingredients: 'ginger beer',
				price: 6.5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'The Saba Special',
				description: 'Mint lemonade & ginger beer.',
				ingredients: 'mint lemonade, ginger beer',
				price: 7,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Fountain Soda',
				description: 'Cola, root beer or fizzy lemonade.',
				ingredients: null,
				price: 5,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Bubly Sparkling Water',
				description: 'Blackberry, peach or pineapple.',
				ingredients: 'sparkling water',
				price: 3,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},

			// --- Mocktails (alcohol-free) ---
			{
				item_name: 'Hibiscus Sangria (Mocktail)',
				description: 'Fruity and sweet, alcohol-free.',
				ingredients: null,
				price: 10,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Balagan Punch (Mocktail)',
				description: 'Bold and sweet, alcohol-free.',
				ingredients: null,
				price: 10,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: "Glowin' G&T (Mocktail)",
				description: 'Floral and fresh, alcohol-free.',
				ingredients: null,
				price: 9,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Pineapple Mockito (Mocktail)',
				description: 'Tart and tropical, alcohol-free.',
				ingredients: null,
				price: 9,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			}
		]
	},
	{
		name: 'Nuba in Kitsilano',
		category: 'restaurant',
		latitude: 49.2640299,
		longitude: -123.1745214,
		address: '3116 W Broadway, Vancouver, BC V6K 2H1',
		phone: '+1 604-559-6822',
		website: 'https://www.nuba.ca/',
		// Kitsilano location of the Nuba Lebanese family; large vegan +
		// gluten-free selection. Vegetarian/vegan items from the official menu
		// (nuba.ca). Prices vary across listings -> left null.
		menu: [
			{
				item_name: 'Baba Ghanouj',
				ingredients: 'char-roasted eggplant, tahini, garlic, lemon, pomegranate reduction',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Falafel Plate',
				ingredients: 'chickpeas, fava beans, vegetables, spices, hummus, salad, pickled cabbage',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Fattoush Salad',
				ingredients: 'romaine, tomato, cucumber, radish, sumac, toasted pita, lemon dressing',
				price: null,
				tags: ['vegan', 'vegetarian', 'dairy_free', 'nut_free']
			},
			{
				item_name: 'Mujadara',
				ingredients: 'green lentils, brown rice, onions, jalapeno',
				price: null,
				tags: ['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free']
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
			description: item.description ?? null,
			ingredients: item.ingredients ?? null,
			price: item.price ?? null,
			tags: item.tags ?? []
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
