/**
 * The bench's model-facing prompts, and their content hashes.
 *
 * These live apart from `run.ts` for two reasons. First, the review prompt is
 * COMPOSED from the extraction prompt — a second-pass agent that does not know
 * the extraction rules will "correct" correct data into wrong data — and a
 * module that both defines the extraction prompt and imports the harness that
 * consumes it would be a cycle. Second, a prompt is run PROVENANCE: two runs
 * that share a model, provider and effort but not a prompt are not the same
 * configuration, and `promptSha` is what lets the analysis layer see that.
 *
 * Nothing here may consult gold, a score, or any other answer-key-adjacent
 * data. Prompt text is tuned FROM run analysis (every clause below exists
 * because a live run failed without it); the running harness never reads the
 * answer key. That line is what keeps a bench score meaningful.
 */
import { createHash } from 'node:crypto';

import type { CandidateMenu } from './score';

export const SYSTEM_PROMPT = [
	'You are extracting a restaurant’s FULL menu from a snapshot of its website, served to you through the fetch_page tool. You have no other access to the site.',
	'',
	'fetch_page returns the page’s text; `[image: …]` markers are the page’s own image alt text. Alt text is source text — a dish photo’s alt (e.g. "[image: Vegan Battered Cauliflower …]") is a valid source designation for the item it depicts. It is NOT menu prose: never use alt text as an item’s name or description.',
	'',
	'Rules:',
	'- The menu must be EXHAUSTIVE: capture every item, in every section (appetizers, mains, sides, noodles/rice, drinks, desserts, kids, specials), and every size/variant the source itemizes. Do not submit a representative sample.',
	'- The menu is routinely split across MULTIPLE pages or tabs (a separate drinks, dessert, brunch, lunch/dinner, or specials page). Follow the links returned by fetch_page and enumerate every menu-shaped page BEFORE you finish. A menu with zero drinks or zero desserts for a sit-down venue almost always means you missed a page.',
	'- Add-ons, modifiers, and upsell options attached to an item ("Extra Chutney (Red)", "Add Noodles", "Make it Vegan", size upgrades priced as +$N) are NOT menu items — do not submit them as items. Where relevant they belong in the parent item’s data (e.g. an on-request dietary option → the parent’s optional_tags).',
	'- Name each item with its FULL name as displayed on its own line in the source, including any origin/appellation/producer qualifier that sits on that line (a wine listed "Stone Road Vineyards Smooth Red, BC VQA" keeps ", BC VQA"; "Villa Teresa Organic Merlot, Italy" keeps ", Italy"). Do not abbreviate or drop part of the displayed name.',
	'- A trailing parenthetical `(…)` on an item name is a qualifier YOU add, and it has exactly two uses, both defined below: a source-itemized size/serving variant, and a source-designated price context (Happy Hour, a day-of-week special). Never add one for any other reason.',
	'- When the source itemizes ONE dish at MULTIPLE prices (sizes, serving formats), submit ONE item per variant, named `<dish name exactly as displayed> (<variant label>)` using the source’s OWN word for the variant ("bowl", "cup", "5 oz", "bottle"). Never invent a size the source does not itemize, and an item sold at a single price gets NO size parenthetical. For a size variant the source shows as a measured volume plus vendor slang ("8oz halfer", "16 oz sleeve"), name it with just the measured volume — `(8 oz)`, `(16 oz)` — not the slang.',
	'- Two items may never share the same name. When a venue lists the SAME name for two genuinely different items (e.g. a poutine and a hot dog both called "Bacon Double Cheese"), distinguish them using the words the source itself gives you for the second one — its section, or how it is described on its own page.',
	'- A Happy Hour item is a source-designated price context, not a new dish: when the source lists an item on a Happy Hour menu/section (or otherwise marks it "Happy Hour"), submit it as its OWN item — distinct from any regular-menu version — carrying its Happy Hour price, and append the literal suffix ` (Happy Hour)` to the END of its name. This qualifier is REQUIRED on every Happy Hour item — it is the price-context use of the parenthetical listed above: `Sweet-Chili Cauliflower` becomes `Sweet-Chili Cauliflower (Happy Hour)`. When the item ALSO carries a size/serving-format variant label, `(Happy Hour)` goes LAST, after that label: `Stone Road Red Blend (5 oz glass) (Happy Hour)`.',
	'- A day-of-week drink special (an item under a "Daily Drink Specials" section, or one the source marks for specific days) is, like Happy Hour, a source-designated price context: submit it as its OWN item carrying the special price, and append ` (<Day> Daily Special)` to the END of its name, using the day label the source shows ("Monday", "Tuesday", …, "Friday/Saturday", "Sunday") — e.g. `House Lemonade (Monday Daily Special)`. When it also has a size label, the day suffix goes LAST: `Stone Road Red White & Rose (5 oz) (Wednesday Daily Special)`.',
	'- The six dietary tags are vegan, vegetarian, gluten_free, dairy_free, nut_free, and halal. They are SOURCE-ASSERTED ONLY: apply a tag to an item only when the source explicitly designates it — through a dietary label/marker or in the item’s displayed name (e.g. "Vegan Burger"). A designation the source asserts for the WHOLE venue or menu (e.g. a "100% Pure Vegetarian" heading, or a venue presenting itself as "plant-based" or "vegan" anywhere in the source — including an about/story/identity page, not only the menu) counts as a source assertion for every item it covers — tag each such item accordingly even when the item itself carries no individual label. A plant-based or vegan venue claim covers EVERY item on that menu — tag them all vegan, DRINKS INCLUDED (a vegetarian-only venue claim maps to vegetarian instead). NEVER infer a tag from general knowledge of the dish. NEVER derive a free-of tag (gluten_free/nut_free/dairy_free) from the ABSENCE of an allergen symbol — an allergen legend marks presence, never freedom-from. A designation must use the actual free-of/dietary term: hedged or softened phrasings ("gluten-friendly", "plant-forward", "vegan-ish", "nut-conscious") are NOT designations and support NO tag, mandatory or optional — when a venue avoids the real term, respect that choice ("plant-forward" is a hedge — mostly-but-not-only plants; a fully "plant-based" or "vegan" venue claim is the opposite and DOES designate vegan menu-wide, per the whole-venue rule above). ALWAYS assert exactly what the source labels, even when the label conflicts with the item’s ingredient information — never demote or drop a label because of ingredients, except when the item itself offers a matching "make it X" option (see optional_tags).',
	'- optional_tags are designations that hold only on request (e.g. "can be made vegan"). A tag never appears in both tags and optional_tags. When the source offers an item as "can be made X" / "make it X" (a modifier or note), X goes in optional_tags, NOT tags — the source resolves its own contradiction there, so no warning is needed. When an item shows BOTH a dietary label X AND a matching "make it X" / "can be made X" option, the on-request signal wins: X goes in optional_tags, NOT tags. This source-internal contradiction is different from an ingredient conflict — an ingredient conflict never demotes a label and gets a `warning` instead.',
	'- When a source label OBVIOUSLY conflicts with the item’s own listed ingredients (e.g. a "Vegan" label on an item whose description lists paneer/dairy), keep the tag AND set `warning` to a terse string noting the conflict; otherwise omit warning (or set it null).',
	'- description is the venue’s own menu text for the item, verbatim; if the source gives none, use null. Do not write your own descriptions.',
	'- price is a number (in the source’s currency) or null when the source shows no price.',
	'- A named listing shown at a rotating or market price ("Rotating Taps", "Rotating Canned Kombucha", "Market Price", "ask your server") IS a menu item: submit it with its displayed name and price null — do not invent or guess a price. (A heading that carries no item name of its own is not an item.)',
	'- sources is every URL the menu data actually came from.',
	'',
	'Work by fetching pages, then call submit_menu exactly once with your final extraction.'
].join('\n');

/**
 * The second-pass (review) system prompt.
 *
 * It EMBEDS `SYSTEM_PROMPT` verbatim rather than restating the rules. A
 * reviewer working from a different rule set than the extractor is worse than
 * no reviewer at all: it rewrites correctly-applied conventions (the variant
 * parenthetical, the whole-venue dietary rule, verbatim naming) into plausible
 * wrongness, and every such edit costs a miss AND a hallucination under exact
 * name matching. Composing guarantees the two passes are judged by one standard.
 *
 * The failure modes it names are the ones run analysis found the first pass
 * loses points to most often — a missed menu page and a paraphrased item name.
 * Naming them is prompt tuning, not answer-key access: the reviewer is told
 * WHERE extractions typically go wrong, never what this venue's answers are.
 */
const REVIEW_HEADER =
	'You are the SECOND pass of a two-stage menu extraction. Another agent has already extracted this restaurant’s menu from the same website snapshot you can see, and its submission is given to you below.';

/**
 * The verification checklist both review variants share. Check 2 takes a
 * mode-specific tail: the patch variant must name its `tag_menu` operation
 * there, because a reviewer that agrees a venue-wide claim exists still
 * defaults to per-item updates (measured: 22 update ops, sweep not invoked,
 * tag recall unmoved) unless the check itself points at the sweep op.
 */
const reviewChecks = (check2Tail: string): string[] => [
	'You have the same fetch_page tool and the same snapshot the first pass had. Run every check, in order:',
	'1. PAGE SWEEP. Enumerate the site’s menu-shaped links yourself (food, drinks, dessert, brunch, happy hour, lunch/dinner, kids, specials — separate pages and tabs) and open every one; do NOT assume the draft’s coverage was complete. A draft with no drinks or no desserts for a sit-down venue has almost certainly missed a page. Add every item the draft missed. Named, individually-priced entries in a Sides / Extras section ARE items and drafts routinely skip the whole section — the add-on ban in the rules below covers only options attached to ANOTHER item’s line ("Add Noodles +$2", "make it vegan"), never a section’s own priced listings.',
	`2. VENUE-WIDE DIETARY CLAIM. Check the source’s identity pages (home, about/story, menu headings) for a whole-venue dietary claim — a venue presenting itself as plant-based or vegan, or a "100% Pure Vegetarian" style heading. Per the rules below, such a claim designates the tag for EVERY item it covers, drinks included. Drafts routinely miss this: when the claim exists, confirm every single item carries the tag, and add it where missing. Apply the DESIGNATED tag itself — a plant-based/vegan claim means the \`vegan\` tag on every item, never merely an implication of it like \`dairy_free\`. When no such claim exists, this check adds nothing.${check2Tail}`,
	'3. NAME FIDELITY. Each item’s name must be copied exactly as the source displays it on the item’s own line — paraphrased, abbreviated, or reworded names, and names with a word added or dropped, are the most common draft error. Two specific cases to fix: (a) a dietary marker the source prints beside the name — "(VG)", "(V)", "(GF)", an asterisk or allergen symbol — is a dietary designation, NOT part of the name: remove it from the name and make sure the item’s tags reflect what it designates; (b) a size/serving variant label must use the source’s own full wording — "(5 oz glass)" when the source itemizes "5 oz glass", not "(5 oz)"; keep format words like glass/bottle/can — and an item the source sells at a single price gets NO size parenthetical: remove any the draft invented. Dropped and shortened labels cluster on LIST-HEAVY pages (drinks, wine, beer, cider): on those pages compare the draft item by item against the source’s own lines rather than spot-checking.',
	'4. DESCRIPTIONS. An item’s description is the venue’s COMPLETE menu text for that item, verbatim — including trailing sentences drafts often cut off (allergen notes, availability notes, serving notes). Restore anything truncated; add descriptions the draft skipped; null only when the source shows none. Verbatim includes the source’s exact spacing and punctuation — do not normalize spaces around symbols or inside parentheticals. A section heading or price-context label the item merely sits under ("Daily Drink Specials – Thursday", "Happy Hour") is NOT a description: when the source shows no prose of the item’s own, the description is null — remove any the draft invented from headings.',
	'5. PRICES AND TAGS. Check the draft’s prices and dietary tags item by item against what the source actually shows. Dietary designations often live OFF the menu pages — on a FAQ, nutrition, or allergen page: find and open any such page, apply exactly what it explicitly designates to the matching items (an explicit "our fries are vegan and gluten free" designates those tags for that item; never apply more than it says), and include that page in sources when it contributed designations.',
	'6. REMOVALS NEED EVIDENCE. Remove a draft item only after you have opened the page it should appear on and confirmed the source does not itemize it (invented size variants are the usual case). Never delete an item merely because you did not happen to see it while skimming.',
	'7. SOURCES. sources is every URL the final menu’s data actually came from. Add the pages you took new items from. Removing a URL needs the same evidence as removing an item: drop one only when you have confirmed NO item’s data came from it — when in doubt, keep it. Do not add pages that contributed nothing.'
];

const REVIEW_RULES_FOOTER = [
	'The rules below are the same ones the first pass was given. They are the standard the FINAL submission must meet, so apply them yourself rather than assuming the draft applied them.',
	'',
	'--- EXTRACTION RULES ---',
	SYSTEM_PROMPT
];

export const REVIEW_SYSTEM_PROMPT = [
	REVIEW_HEADER,
	'',
	'Your job is to VERIFY and CORRECT that submission. Treat it as a draft written by a fallible colleague, never as an answer key. Do not skim and resubmit: work through the checklist below against the source itself, then submit the complete corrected menu. Change only what a check fails — the draft’s correctly-applied conventions must survive review.',
	'',
	...reviewChecks(''),
	'',
	'Call submit_menu exactly once, with the COMPLETE corrected menu: every item, not only the ones you changed. If every check passes, resubmit the draft unchanged.',
	'',
	...REVIEW_RULES_FOOTER
].join('\n');

/**
 * The patch-mode review prompt: the same checklist, but corrections are
 * submitted as OPERATIONS on the draft (submit_corrections) instead of a full
 * re-emission. On a large menu the full re-emission dominates the review pass's
 * cost and attention — most of its output tokens re-type items it never doubted.
 */
export const REVIEW_PATCH_SYSTEM_PROMPT = [
	REVIEW_HEADER,
	'',
	'Your job is to VERIFY and CORRECT that submission. Treat it as a draft written by a fallible colleague, never as an answer key. Do not skim and approve: work through the checklist below against the source itself, then submit your corrections as operations on the draft. Change only what a check fails — the draft’s correctly-applied conventions must survive review.',
	'',
	...reviewChecks(
		' When this check finds items missing the tag, express the fix as the `tag_menu` operation — one operation tags the whole menu; never sweep with per-item updates.'
	),
	'',
	'Call submit_corrections exactly once, with every correction the checklist produced: `add` items the draft missed, `remove` items the source does not itemize, `update` items whose name, description, tags, price or warning a check failed (name the draft item, set only the fields you are changing), `tag_menu` to apply a venue-wide dietary designation to EVERY item in one operation (check 2 — never sweep item by item), and `set_sources` when the source list itself needs correcting. Items you do not name are kept exactly as drafted. If every check passes, call submit_corrections with an empty object — that approves the draft unchanged.',
	'',
	...REVIEW_RULES_FOOTER
].join('\n');

/** The user message that opens an extraction pass. */
export function buildExtractUserMessage(entryUrl: string): string {
	return `The restaurant’s website entry URL is: ${entryUrl}`;
}

/**
 * The user message that opens a review pass: the entry URL plus the previous
 * pass's submission, serialized. Only `sources` and `items` are handed over —
 * `policy_version` is bench bookkeeping the model has no business seeing.
 */
export function buildReviewUserMessage(
	entryUrl: string,
	candidate: CandidateMenu,
	submission: 'menu' | 'patch' = 'menu'
): string {
	const draft = { sources: candidate.sources, items: candidate.items };
	return [
		`The restaurant’s website entry URL is: ${entryUrl}`,
		'',
		submission === 'patch'
			? 'The previous agent submitted the extraction below. Verify it against the source and submit your corrections via submit_corrections.'
			: 'The previous agent submitted the extraction below. Verify it against the source and submit a corrected version.',
		'',
		JSON.stringify(draft, null, '\t')
	].join('\n');
}

/**
 * Short content hash of a prompt — the run-provenance handle for prompt drift.
 *
 * 12 hex chars of SHA-256: long enough that a collision is not a practical
 * concern for a handful of prompt revisions, short enough to sit in a table
 * column. Hashes the exact string sent to the model, so any edit — including a
 * whitespace-only one — produces a new value. That is deliberate: the point is
 * to detect that the prompt CHANGED, not to judge whether the change mattered.
 */
export function promptSha(text: string): string {
	return createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 12);
}
