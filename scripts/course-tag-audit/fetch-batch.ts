// Deterministic FETCH step of the course-tag audit session (no LLM involved).
//
// Pulls the next page of the missing_course_tag backlog straight from the
// remote D1 — the same population the audit_locations check reports (items
// with no required course tag), ordered hint-first (drink, dessert, none)
// so likely-mistagged items lead. Writes the page as JSON for the
// classification workflow (.claude/workflows/course-tag-audit.js) to consume
// via its `items` arg.
//
//   bun scripts/course-tag-audit/fetch-batch.ts [limit] > page.json
//
// Only the CLASSIFICATION of these items needs a model; this fetch and the
// matching apply-classifications.ts are pure data plumbing.

import { spawnSync } from 'node:child_process';
import { TAGS } from '../../src/lib/tags';

const limit = Math.min(Math.max(Number(process.argv[2] ?? 200), 1), 20000);
const courseIds = TAGS.filter((t) => t.tag_type === 'course').map((t) => t.id);

const sql =
	`SELECT i.id, i.item_name, i.description, m.name AS menu_name FROM items i ` +
	`JOIN menus m ON m.id = i.menu_id WHERE NOT EXISTS (SELECT 1 FROM item_tags it ` +
	`WHERE it.item_id = i.id AND it.optional = 0 AND it.tag_id IN (${courseIds.map((c) => `'${c}'`).join(',')}))`;

const run = spawnSync(
	'bunx',
	['wrangler', 'd1', 'execute', 'better-food-map', '--remote', '--json', '--command', sql],
	{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
);
if (run.status !== 0) {
	console.error(run.stderr);
	process.exit(1);
}
const out = run.stdout;
const rows: Array<{
	id: string;
	item_name: string;
	description: string | null;
	menu_name: string;
}> = JSON.parse(out.slice(out.indexOf('[')))[0].results;

// Same keyword hints the audit check uses: whole-word matching so "chocolate"
// never matches "cola" and "platter" never matches "latte".
const DRINK = [
	'latte',
	'coffee',
	'espresso',
	'cappuccino',
	'americano',
	'mocha',
	'macchiato',
	'juice',
	'smoothie',
	'lassi',
	'lemonade',
	'milkshake',
	'shake',
	'soda',
	'pop',
	'cola',
	'iced tea',
	'tea',
	'chai',
	'hot chocolate',
	'frappe',
	'frappuccino',
	'slush',
	'kombucha',
	'water',
	'drink',
	'beverage',
	'boba',
	'milk'
];
const DESSERT = [
	'cheesecake',
	'ice cream',
	'cookie',
	'cookies',
	'brownie',
	'sundae',
	'donut',
	'doughnut',
	'gelato',
	'baklava',
	'tiramisu',
	'mousse',
	'churro',
	'custard',
	'pudding',
	'cake',
	'cakes',
	'pie',
	'tart',
	'pastry',
	'dessert',
	'sweets',
	'kulfi',
	'gulab',
	'halwa',
	'ladoo',
	'laddu',
	'burfi',
	'jalebi',
	'mochi',
	'sorbet',
	'soft serve',
	'parfait',
	'muffin',
	'waffle',
	'crepe'
];
const norm = (s: string) =>
	' ' +
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim() +
	' ';
const hint = (name: string): 'drink' | 'dessert' | null => {
	const n = norm(name);
	if (DRINK.some((w) => n.includes(` ${w} `))) return 'drink';
	if (DESSERT.some((w) => n.includes(` ${w} `))) return 'dessert';
	return null;
};

const rank = { drink: 0, dessert: 1, null: 2 } as const;
const page = rows
	.map((r) => ({ ...r, hint: hint(r.item_name) }))
	.toSorted(
		(a, b) =>
			rank[String(a.hint) as keyof typeof rank] - rank[String(b.hint) as keyof typeof rank] ||
			a.menu_name.localeCompare(b.menu_name) ||
			a.item_name.localeCompare(b.item_name)
	)
	.slice(0, limit);

console.log(JSON.stringify({ total: rows.length, items: page }));
