export const meta = {
	name: 'course-tag-audit',
	description:
		'Classify menu items as food/dessert/drink with parallel Haiku agents (classification ONLY)',
	whenToUse:
		'The classification stage of a course-tag audit session — the ONLY stage that needs a model. Fetch the page first with `bun scripts/course-tag-audit/fetch-batch.ts <limit>` (deterministic), pass its items array as args: { items: [...], model?: "sonnet" | "haiku" } (default sonnet — haiku is ~5% wrong on culturally-specific dishes), then apply the returned classifications with `bun scripts/course-tag-audit/apply-classifications.ts` (deterministic, additive inserts, reversibility log).',
	phases: [{ title: 'Classify', detail: 'parallel course classification' }]
};

// args.items: [{ id, item_name, menu_name, description?, hint? }] from fetch-batch.ts.
// Tolerate a JSON-encoded string arriving instead of a parsed object.
const input = typeof args === 'string' ? JSON.parse(args) : args;
const items = input?.items;
if (!Array.isArray(items) || items.length === 0) {
	throw new Error(
		'pass args: { items: [...] } — produce it with bun scripts/course-tag-audit/fetch-batch.ts'
	);
}
const BATCH = 40;
// Sonnet by default: Haiku measured ~95% on this task, and the misses were
// exactly the judgment calls the session exists to settle (e.g. it called a
// taro-coconut dessert soup "food"). Pass model: 'haiku' for a cheap rough pass.
const model = input?.model === 'haiku' ? 'haiku' : 'sonnet';

const CLASSIFY_SCHEMA = {
	type: 'object',
	required: ['classifications'],
	properties: {
		classifications: {
			type: 'array',
			items: {
				type: 'object',
				required: ['id', 'course'],
				properties: {
					id: { type: 'string' },
					course: { type: 'string', enum: ['food', 'dessert', 'drink', 'dessert+drink', 'unsure'] },
					note: { type: 'string' }
				}
			}
		}
	}
};

const CLASSIFY_RULES =
	"Classify each menu item's COURSE per the food-map tag policy:\n" +
	'- "food": neither dessert nor drink — mains, appetizers, sides, breads, breakfast dishes, savory baked ' +
	'goods, combo/meal deals (a combo that INCLUDES a drink/dessert is still food), sauces/add-ons/modifiers.\n' +
	'- "dessert": sweet course — cakes, ice cream, Indian sweets (gulab jamun, kulfi, ladoo, burfi, jalebi, ' +
	'kheer, halwa), sweet pastries, cookies, puddings, sweet pies/tarts.\n' +
	'- "drink": beverages — coffee/espresso drinks, tea and chai, lassi and milkshakes (an Indian-restaurant ' +
	'"Mango Shake" is a drink), juices, sodas, bubble tea, water.\n' +
	'- "dessert+drink": ONLY genuinely both (a milkshake sold as dessert, an ice-cream float). Rare.\n' +
	'- "unsure": you cannot tell from name + description + menu context. NEVER guess — return unsure instead.\n' +
	'TRAPS (all food, not dessert): crab/fish/turnip/radish/rice/scallion cake, Chinese donut (youtiao), ' +
	'meat/spinach/zaatar/frito/scotch pie, savoury pastry, golgappe/pani-puri water (food accompaniment), ' +
	'smoothie BOWLS (eaten with a spoon), "Chicken Pop-Ins" (fried chicken), tea-smoked dishes, pancakes and ' +
	'other breakfast plates. Masala/Kashmiri/Cutting Chai = drink.';

const batches = [];
for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));

phase('Classify');
const results = await pipeline(batches, (batch, _item, i) =>
	agent(
		`${CLASSIFY_RULES}\n\nItems (JSON):\n${JSON.stringify(batch)}\n\n` +
			'Return structured output with one classification per item id — every id exactly once.',
		{ label: `classify-${i}`, phase: 'Classify', schema: CLASSIFY_SCHEMA, model }
	)
);

const classifications = [];
const failedBatches = [];
results.forEach((r, i) => {
	if (!r) return failedBatches.push(i);
	const ids = new Set(batches[i].map((b) => b.id));
	classifications.push(...r.classifications.filter((c) => ids.has(c.id)));
});
const unsure = classifications.filter((c) => c.course === 'unsure').length;
log(
	`Classified ${classifications.length}/${items.length} (${unsure} unsure${failedBatches.length ? `, ${failedBatches.length} batch(es) failed` : ''})`
);
return { classifications, failed_batches: failedBatches };
