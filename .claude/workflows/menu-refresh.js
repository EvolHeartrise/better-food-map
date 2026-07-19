export const meta = {
	name: 'menu-refresh',
	description:
		'Refresh stale menus: re-extract from banked sources, risk-routed verification, tiered auto-apply',
	whenToUse:
		'Periodic menu-staleness drain. BEFORE invoking, run the deterministic source-change gate: `bun run menu:check --limit N` (scripts/menu-fingerprint/) fingerprints the stalest menus’ watch urls, stamps hash-stable ones as checked (no agent needed), and prints the menus that actually changed — pass its `needs_refresh` rows as the `menus` arg so agent tokens are spent only where the source moved. AFTER the workflow completes, re-baseline every refreshed menu: `bun run menu:baseline <menu_id> …` (ids in the report’s `baseline_next` field). Invoke with args: { today: "YYYY-MM-DD", limit?: number (default 10), menus?: [...], model?: "sonnet" }. If `menus` is omitted, a selection agent picks the `limit` stalest menus itself (list_menus, last_verified ascending, never-verified first — pure staleness, chains NOT weighted up); pass `menus` [{ menu_id, menu_name, brand_id?, last_verified, item_count, location_count }] to hand-pick the batch instead. All subagents run on Sonnet 5. Auto-applies: new items, price/description updates, zero-like stale deletions, sources + refresh_notes. STAGES for user review (returned, never written): liked-item deletions, dietary-tag changes on existing items, suspected closures.',
	phases: [
		{
			title: 'Select',
			detail: 'pick the N stalest menus via list_menus (skipped when menus passed in args)',
			model: 'sonnet'
		},
		{
			title: 'Extract',
			detail: 'per menu: liveness, page inventory, exhaustive re-extraction, diff',
			model: 'sonnet'
		},
		{
			title: 'Verify',
			detail: 'risk-routed: completeness-only (empty diff) / spot-check (low) / adversarial (high)',
			model: 'sonnet'
		},
		{
			title: 'Closure',
			detail: 'dead-source venues: closed / moved / new-site investigation',
			model: 'sonnet'
		},
		{
			title: 'Apply',
			detail: 'auto-tier writes via menu-refresh-writer; staged tier collected for review',
			model: 'haiku'
		}
	]
};

// ---------- input (tolerate JSON-encoded string args — known Workflow gotcha) ----------
const input = typeof args === 'string' ? JSON.parse(args) : args;
const today = input?.today;
if (!today) {
	throw new Error(
		'pass args: { today: "YYYY-MM-DD", limit?: number, menus?: [...] } — today is required (scripts cannot read the clock)'
	);
}
const MODEL = input?.model || 'sonnet';
const limit = Math.max(
	1,
	Number(input?.limit) || (Array.isArray(input?.menus) ? input.menus.length : 10)
);

// ---------- schemas ----------
const MENU_ROW = {
	type: 'object',
	properties: {
		menu_id: { type: 'string' },
		menu_name: { type: 'string' },
		brand_id: { type: ['string', 'null'] },
		last_verified: { type: ['string', 'null'] },
		item_count: { type: 'number' },
		location_count: { type: 'number' }
	},
	required: ['menu_id', 'menu_name', 'item_count', 'location_count']
};

const SELECT_SCHEMA = {
	type: 'object',
	properties: { menus: { type: 'array', items: MENU_ROW } },
	required: ['menus']
};

const NEW_ITEM = {
	type: 'object',
	properties: {
		item_name: { type: 'string' },
		price: { type: ['number', 'null'] },
		description: { type: ['string', 'null'] },
		tags: { type: 'array', items: { type: 'string' } },
		optional_tags: { type: 'array', items: { type: 'string' } },
		tag_evidence: {
			type: 'string',
			description: 'What in the source asserts each dietary tag; "none" if only course tags'
		}
	},
	required: ['item_name', 'tags', 'tag_evidence']
};

const EXTRACT_SCHEMA = {
	type: 'object',
	properties: {
		status: { type: 'string', enum: ['refreshed', 'dead_source', 'suspected_closed', 'blocked'] },
		status_detail: { type: 'string' },
		page_inventory: {
			type: 'array',
			description:
				'EVERY menu-shaped nav link found (food/drinks/desserts/specials — NOT merch or non-food pages), ingested or not',
			items: {
				type: 'object',
				properties: {
					url: { type: 'string' },
					label: { type: 'string' },
					extracted: { type: 'boolean' },
					skip_reason: {
						type: 'string',
						description:
							'Only when extracted=false AND the skip is deliberately safe (page is redundant with an extracted one, e.g. a nutrition PDF duplicating the extracted feed). An unreadable/unfetched menu page gets NO skip_reason.'
					}
				},
				required: ['url', 'label', 'extracted']
			}
		},
		confirmed_unchanged_count: {
			type: 'number',
			description:
				'How many existing DB items you POSITIVELY confirmed still present on the source (matched name on an extracted page). An empty diff is only credible when this equals the menu item count.'
		},
		source_quality: {
			type: 'string',
			enum: ['feed', 'pdf', 'html_single', 'html_scattered', 'aggregator_only'],
			description: 'Most machine-readable format actually used'
		},
		proposed_sources: {
			type: 'array',
			description: '1–3 canonical browsable pages, never API endpoints',
			items: {
				type: 'object',
				properties: { url: { type: 'string' }, label: { type: 'string' } },
				required: ['url']
			}
		},
		proposed_refresh_notes: {
			type: 'string',
			description:
				'Full replacement refresh_notes: fetch method, feed endpoints, caveats, COMPLETE page inventory'
		},
		diff: {
			type: 'object',
			properties: {
				new_items: { type: 'array', items: NEW_ITEM },
				changed_items: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							item_name: { type: 'string' },
							price: { type: ['number', 'null'] },
							description: { type: ['string', 'null'] },
							change_note: { type: 'string' }
						},
						required: ['id', 'item_name', 'change_note']
					}
				},
				delisted_items: {
					type: 'array',
					description: 'Items in DB but absent from EVERY source page',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							item_name: { type: 'string' },
							likes: {
								type: 'number',
								description: 'Like count from get_menu/get_item; 0 if none shown'
							},
							evidence: { type: 'string' }
						},
						required: ['id', 'item_name', 'likes', 'evidence']
					}
				},
				dietary_tag_changes: {
					type: 'array',
					description: 'Add/remove of a DIETARY tag on an EXISTING item',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							item_name: { type: 'string' },
							tag: { type: 'string' },
							action: { type: 'string', enum: ['add', 'remove'] },
							evidence: { type: 'string' }
						},
						required: ['id', 'item_name', 'tag', 'action', 'evidence']
					}
				}
			},
			required: ['new_items', 'changed_items', 'delisted_items', 'dietary_tag_changes']
		}
	},
	required: [
		'status',
		'status_detail',
		'page_inventory',
		'confirmed_unchanged_count',
		'source_quality',
		'proposed_sources',
		'proposed_refresh_notes',
		'diff'
	]
};

const VERIFY_SCHEMA = {
	type: 'object',
	properties: {
		overall_ok: { type: 'boolean' },
		missing_pages: {
			type: 'array',
			items: { type: 'string' },
			description: 'Menu-shaped links the extractor missed'
		},
		rejected: {
			type: 'array',
			description: 'Diff entries that do NOT hold against the source (ref = "kind:id_or_name")',
			items: {
				type: 'object',
				properties: { ref: { type: 'string' }, reason: { type: 'string' } },
				required: ['ref', 'reason']
			}
		},
		notes: { type: 'string' }
	},
	required: ['overall_ok', 'missing_pages', 'rejected', 'notes']
};

const CLOSURE_SCHEMA = {
	type: 'object',
	properties: {
		verdict: { type: 'string', enum: ['confirmed_closed', 'open', 'moved', 'unresolved'] },
		evidence: { type: 'string' },
		evidence_urls: { type: 'array', items: { type: 'string' } },
		new_menu_url: {
			type: ['string', 'null'],
			description: 'Working menu URL if the venue is open at a new site'
		}
	},
	required: ['verdict', 'evidence', 'evidence_urls']
};

const APPLY_SCHEMA = {
	type: 'object',
	properties: {
		created: { type: 'number' },
		updated: { type: 'number' },
		deleted: { type: 'number' },
		skipped_existing: {
			type: 'number',
			description: 'Creates skipped because the item_name already exists on the menu'
		},
		menu_updated: { type: 'boolean' },
		errors: { type: 'array', items: { type: 'string' } }
	},
	required: ['created', 'updated', 'deleted', 'skipped_existing', 'menu_updated', 'errors']
};

// Data policies (dietary tags, page inventory, sources, descriptions) live in the
// menu-refresh-reader agent's system prompt — cached once per agent, not re-shipped per prompt.
const POLICY_REF = 'The data policies in your system prompt are binding.';

// ---------- stage 0: batch selection (skipped when the caller hand-picks) ----------
let batch;
if (Array.isArray(input?.menus) && input.menus.length > 0) {
	batch = input.menus.slice(0, limit);
	log(`Using caller-provided batch: ${batch.length} menus`);
} else {
	const sel = await agent(
		`Call list_menus (food-db). Select the ${limit} STALEST menus, strictly: (1) drop menus with location_count 0 (no open branches) or item_count 0; (2) sort by last_verified ascending, with null/never-verified first; (3) NO other weighting — a chain menu ranks purely by its own staleness. Return the top ${limit} rows verbatim (menu_id, menu_name, brand_id, last_verified, item_count, location_count).`,
		{
			label: `select:${limit} stalest`,
			phase: 'Select',
			schema: SELECT_SCHEMA,
			model: MODEL,
			effort: 'low',
			agentType: 'menu-refresh-reader'
		}
	);
	batch = sel?.menus ?? [];
	if (batch.length === 0) throw new Error('selection agent returned no menus');
}
log(`Refreshing ${batch.length} menus (stalest first), as of ${today}`);

// ---------- stage 1: extract + diff ----------
async function extract(menu, hintUrl) {
	return agent(
		`Refresh the menu "${menu.menu_name}" (menu_id: ${menu.menu_id}${menu.brand_id ? `, brand_id: ${menu.brand_id}` : ''}). Today is ${today}; last verified ${menu.last_verified ?? 'never'}. It currently has ${menu.item_count} items across ${menu.location_count} open location(s).

1. get_menu (view: "full") — read refresh_notes FIRST; they bank how to re-fetch (feed endpoints, page inventory, caveats). ${menu.brand_id ? 'This is a shared CHAIN menu — work from the chain’s regional/official menu source.' : 'Independent venue: get_location for its website/contact if refresh_notes are thin.'}
2. Liveness check BEFORE deep research: if the venue/chain appears permanently closed (dead site + "permanently closed" signals), return status "suspected_closed" with what you saw and stop. If the banked source is gone but the business seems alive, return "dead_source". If bot-walled and Browser Rendering also fails, return "blocked". CRITICAL: if the PRIMARY menu surface (the site's main menu/ordering pages) cannot be rendered or fetched, status is "blocked" even when a PDF or some subset IS readable — never report "refreshed" from a partial read of the source.${hintUrl ? `\n   A closure investigation already found the venue OPEN with a working menu at: ${hintUrl} — start there.` : ''}
3. Page inventory: enumerate EVERY menu-shaped link on the current site before extracting — check the nav AND web-search the domain's own indexed pages (per your system prompt) so client-rendered nav can't hide pages. Report all of them in page_inventory (menu-shaped pages only, no merch), including any you could not extract (extracted: false, and skip_reason ONLY when the skip is safe because the page is redundant with one you extracted).
4. Extract every page exhaustively, then DIFF against the DB items from step 1:
   - new_items: on the source, not in DB (course tags mandatory; dietary tags only with tag_evidence).
   - changed_items: price/description changes (description = venue's own copy or null).
   - delisted_items: in DB, absent from EVERY source page — include each item's like count (get_item if get_menu doesn't show it; use 0 only when the data says 0).
   - dietary_tag_changes: adds/removes on EXISTING items, each with source evidence. When a tag's only support would be allergen-symbol ABSENCE, that is a "remove" with that stated as evidence.
   Unchanged items: omit entirely, but COUNT them — confirmed_unchanged_count is the number of DB items you positively matched on an extracted page. An empty diff is a positive claim that you confirmed all ${menu.item_count} items still on the source; if you could not check them all, the un-checked pages must appear in page_inventory as extracted: false (no skip_reason). Do NOT write anything to the DB — you are extract-and-diff only.
5. proposed_refresh_notes must let the next refresh skip re-discovery: fetch method, any feed endpoint, caveats, and the full page inventory with URLs. proposed_sources: 1–3 browsable pages.

${POLICY_REF} Return ONLY the structured object.`,
		{
			label: `extract:${menu.menu_name}`,
			phase: 'Extract',
			schema: EXTRACT_SCHEMA,
			model: MODEL,
			agentType: 'menu-refresh-reader'
		}
	);
}

// ---------- stage 2 helpers ----------
const diffEmpty = (d) =>
	d.new_items.length === 0 &&
	d.changed_items.length === 0 &&
	d.delisted_items.length === 0 &&
	d.dietary_tag_changes.length === 0;

function riskTier(ex, menu) {
	if (diffEmpty(ex.diff)) {
		// "Unchanged" is only cheap to accept when the read was total: clean source
		// format, every inventoried page extracted (or safely skipped as redundant),
		// and every DB item positively re-matched. Anything less is the KFC failure
		// mode — an unreadable site reported as an empty diff — and verifies at HIGH.
		const totalRead =
			['feed', 'pdf', 'html_single'].includes(ex.source_quality) &&
			ex.page_inventory.every((p) => p.extracted || p.skip_reason) &&
			ex.confirmed_unchanged_count === menu.item_count;
		return totalRead ? 'none' : 'high';
	}
	if (ex.source_quality === 'html_scattered' || ex.source_quality === 'aggregator_only')
		return 'high';
	const dietaryLoad =
		ex.diff.dietary_tag_changes.length +
		ex.diff.new_items.filter((i) =>
			(i.tags || []).some((t) =>
				['vegan', 'vegetarian', 'gluten_free', 'dairy_free', 'nut_free', 'halal'].includes(t)
			)
		).length;
	if (dietaryLoad >= 5) return 'high';
	if (ex.page_inventory.some((p) => !p.extracted)) return 'high';
	return 'low';
}

async function verify(ex, menu) {
	const tier = riskTier(ex, menu);
	const pagesJson = JSON.stringify(ex.page_inventory);
	if (tier === 'none') {
		// totally-read empty diff: the only failure mode left is a missed page — completeness check only
		return agent(
			`Completeness check for "${menu.menu_name}" — an extractor found the menu at ${ex.proposed_sources.map((s) => s.url).join(', ')} UNCHANGED (all ${menu.item_count} items re-confirmed), with page inventory: ${pagesJson}

Independently derive the menu-page inventory: open the site's nav yourself AND web-search the domain's own indexed pages (per your system prompt). Anything absent from the extractor's inventory goes in missing_pages. A sit-down venue whose menu (${menu.item_count} items) has no drinks or no desserts is a red flag for a missed page. rejected stays []. ${POLICY_REF}`,
			{
				label: `navcheck:${menu.menu_name}`,
				phase: 'Verify',
				schema: VERIFY_SCHEMA,
				model: MODEL,
				effort: 'low',
				agentType: 'menu-refresh-reader'
			}
		);
	}
	const diffJson = JSON.stringify(ex.diff);
	if (tier === 'low') {
		return agent(
			`Spot-check a menu refresh for "${menu.menu_name}" (source quality: ${ex.source_quality}). Extractor's page inventory: ${pagesJson}. Proposed diff: ${diffJson}

Check, against the SAME source format the extractor used (${ex.proposed_sources.map((s) => s.url).join(', ')}; refresh notes: ${JSON.stringify(ex.proposed_refresh_notes)}):
1. Completeness: open the site nav yourself — is any menu-shaped page missing from the inventory? A sit-down venue with zero drinks or zero desserts in the diff+existing menu is a red flag.
2. Sample 5 dietary-tagged entries from the diff (or all, if fewer) and confirm the source explicitly asserts each tag.
3. Sample 3 delisted_items and confirm they are truly absent from every inventoried page.
4. Every new_item must carry a course tag (food/dessert/drink) consistent with its source section; food never combines with the other two.
Reject (rejected[], ref "new:<name>" / "change:<id>" / "delist:<id>" / "tag:<id>:<tag>") anything that fails; when a dietary tag stays uncertain, reject it (source-asserted policy). ${POLICY_REF}`,
			{
				label: `spotcheck:${menu.menu_name}`,
				phase: 'Verify',
				schema: VERIFY_SCHEMA,
				model: MODEL,
				effort: 'low',
				agentType: 'menu-refresh-reader'
			}
		);
	}
	return agent(
		`ADVERSARIAL verification of a high-risk menu refresh for "${menu.menu_name}" (source quality: ${ex.source_quality} — scattered/aggregator sources or heavy dietary-tag load). Page inventory: ${pagesJson}. Proposed diff: ${diffJson}. Sources: ${ex.proposed_sources.map((s) => s.url).join(', ')}. Refresh notes: ${JSON.stringify(ex.proposed_refresh_notes)}

Your default stance is REFUTE. Against the same source FORMAT the extractor cited:
1. Re-derive the page inventory independently from the site nav; list anything missed in missing_pages.
2. EVERY dietary tag in new_items and EVERY entry in dietary_tag_changes: confirm an explicit source assertion (marker, name designation, or dedicated allergen-free listing). Allergen-legend symbol ABSENCE is never support for a free-of tag. Uncertain ⇒ reject.
3. EVERY delisted_item: confirm absence from every inventoried page (a delist that is really a moved-to-another-page item must be rejected).
4. Every new_item's course tag (food/dessert/drink) must match its source section; food never combines with the other two.
5. Spot-check prices/descriptions for transcription errors; descriptions must be venue copy verbatim or null.
Reject via rejected[] with refs "new:<name>" / "change:<id>" / "delist:<id>" / "tag:<id>:<tag>". ${POLICY_REF}`,
		{
			label: `verify:${menu.menu_name}`,
			phase: 'Verify',
			schema: VERIFY_SCHEMA,
			model: MODEL,
			effort: 'high',
			agentType: 'menu-refresh-reader'
		}
	);
}

async function investigateClosure(ex, menu) {
	return agent(
		`The banked menu source for "${menu.menu_name}" (menu_id ${menu.menu_id}) is dead or the venue looks closed. Extractor found: ${ex.status} — ${ex.status_detail}

Determine the venue's real status as of ${today}: check Google/Yelp for "permanently closed", the chain's own store locator if branded, social media, and whether the business moved or just changed domains. Use your get_location tool for the venue's address/website. Verdicts:
- confirmed_closed: hard evidence (listing marked closed, closure notice) — cite it.
- open: business operates and you found a WORKING menu URL — put it in new_menu_url.
- moved: relocated (note where).
- unresolved: signals conflict or nothing found.
Do NOT write to the DB.`,
		{
			label: `closure:${menu.menu_name}`,
			phase: 'Closure',
			schema: CLOSURE_SCHEMA,
			model: MODEL,
			agentType: 'menu-refresh-reader'
		}
	);
}

// ---------- filter diff by verifier rejections + split auto vs staged ----------
function partition(ex, ver) {
	const rejected = new Set((ver?.rejected || []).map((r) => r.ref));
	const auto = {
		new_items: ex.diff.new_items.filter((i) => !rejected.has(`new:${i.item_name}`)),
		changed_items: ex.diff.changed_items.filter((c) => !rejected.has(`change:${c.id}`)),
		// zero-like delists auto-delete ONLY when the verifier did not contradict the delist claim
		deletions: ex.diff.delisted_items.filter(
			(d) => d.likes === 0 && !rejected.has(`delist:${d.id}`)
		)
	};
	const staged = {
		liked_delisted: ex.diff.delisted_items.filter(
			(d) => d.likes > 0 && !rejected.has(`delist:${d.id}`)
		),
		dietary_tag_changes: ex.diff.dietary_tag_changes.filter(
			(t) => !rejected.has(`tag:${t.id}:${t.tag}`)
		)
	};
	return { auto, staged, rejected: ver?.rejected || [], missing_pages: ver?.missing_pages || [] };
}

async function apply(menu, ex, auto) {
	const stampOnly =
		auto.new_items.length === 0 && auto.changed_items.length === 0 && auto.deletions.length === 0;
	const steps = stampOnly
		? `The menu content is verified unchanged — this is a stamp-only refresh.
1. update_menu on menu_id ${menu.menu_id}: sources (REPLACE) = ${JSON.stringify(ex.proposed_sources)}; refresh_notes = ${JSON.stringify(ex.proposed_refresh_notes)}. (This stamps last_verified.)`
		: `1. get_menu (view: "names") first; skip any create below whose item_name already exists on the menu (count in skipped_existing) — this keeps re-runs idempotent.
2. create_items (menu-targeted) for: ${JSON.stringify(auto.new_items)}
3. update_items for price/description changes: ${JSON.stringify(auto.changed_items)}
4. delete_item for each of (zero-like, source-delisted, verified): ${JSON.stringify(auto.deletions.map((d) => ({ id: d.id, item_name: d.item_name })))}
5. update_menu: sources (REPLACE) = ${JSON.stringify(ex.proposed_sources)}; refresh_notes = ${JSON.stringify(ex.proposed_refresh_notes)}. This also stamps last_verified — make it the LAST call so it only lands after the item writes succeed.`;
	return agent(
		`Apply a verified menu refresh to menu_id ${menu.menu_id} ("${menu.menu_name}") using your create_items / update_items / delete_item / update_menu tools.

${steps}

Do exactly this list — no re-research, no extra edits. Record any tool error verbatim in errors[] and continue with the rest.`,
		{
			label: `apply:${menu.menu_name}`,
			phase: 'Apply',
			schema: APPLY_SCHEMA,
			model: 'haiku',
			effort: 'low',
			agentType: 'menu-refresh-writer'
		}
	);
}

// ---------- per-menu pipeline (no barriers: menu A applies while menu B extracts) ----------
const results = await pipeline(
	batch,
	(menu) => extract(menu),
	async (ex, menu) => {
		if (!ex) return { menu, outcome: 'extract_failed' };
		if (ex.status === 'blocked') return { menu, outcome: 'blocked', detail: ex.status_detail, ex };
		if (ex.status === 'dead_source' || ex.status === 'suspected_closed') {
			const closure = await investigateClosure(ex, menu);
			if (closure?.verdict === 'open' && closure.new_menu_url) {
				// one retry with the working URL the investigation found
				const retry = await extract(menu, closure.new_menu_url);
				if (retry?.status === 'refreshed') return { menu, ex: retry, closure };
			}
			return { menu, outcome: 'closure', closure, ex };
		}
		return { menu, ex };
	},
	async (r, menu) => {
		if (!r || r.outcome) return r;
		const ver = await verify(r.ex, menu);
		return { ...r, ver };
	},
	async (r, menu) => {
		if (!r || r.outcome) return r;
		if (r.ver && r.ver.missing_pages.length > 0 && !r.ver.overall_ok) {
			// Verifier found un-extracted menu pages: not safe to apply a partial refresh.
			// But BANK the discovered inventory in refresh_notes (stamp_verified: false —
			// the menu was NOT verified) so the next refresh starts from the full page list.
			const banked = await agent(
				`An incomplete menu refresh for menu_id ${menu.menu_id} ("${menu.menu_name}") discovered menu pages the banked refresh_notes never listed. Bank them WITHOUT marking the menu verified:

1. get_menu (view: "summary") on ${menu.menu_id} and read its current refresh_notes.
2. update_menu with stamp_verified: false and refresh_notes = the existing notes MERGED with (do not lose any existing information): the extractor's findings ${JSON.stringify(r.ex.proposed_refresh_notes)} and these additional menu pages a verifier discovered: ${JSON.stringify(r.ver.missing_pages)}.
Make NO other changes (no sources, no items). stamp_verified: false is required — this menu's data was NOT re-verified.`,
				{
					label: `banknotes:${menu.menu_name}`,
					phase: 'Apply',
					schema: APPLY_SCHEMA,
					model: 'haiku',
					effort: 'low',
					agentType: 'menu-refresh-writer'
				}
			);
			return {
				menu,
				outcome: 'incomplete',
				ex: r.ex,
				ver: r.ver,
				banked_notes: banked?.errors?.length === 0
			};
		}
		const parts = partition(r.ex, r.ver);
		const applied = await apply(menu, r.ex, parts.auto);
		log(
			`${menu.menu_name}: +${applied?.created ?? '?'} new, ${applied?.updated ?? '?'} updated, ${applied?.deleted ?? '?'} deleted; staged ${parts.staged.liked_delisted.length + parts.staged.dietary_tag_changes.length}`
		);
		return { menu, outcome: 'refreshed', ex: r.ex, ver: r.ver, parts, applied };
	}
);

// ---------- report ----------
const done = results.filter(Boolean);
const report = {
	as_of: today,
	requested: batch.length,
	refreshed: done
		.filter((r) => r.outcome === 'refreshed')
		.map((r) => ({
			menu: r.menu,
			applied: r.applied,
			verifier_rejected: r.parts.rejected,
			staged: r.parts.staged,
			page_inventory: r.ex.page_inventory
		})),
	staged_closures: done
		.filter((r) => r.outcome === 'closure')
		.map((r) => ({ menu: r.menu, closure: r.closure, extractor_saw: r.ex?.status_detail })),
	incomplete: done
		.filter((r) => r.outcome === 'incomplete')
		.map((r) => ({
			menu: r.menu,
			missing_pages: r.ver.missing_pages,
			notes: r.ver.notes,
			refresh_notes_banked: r.banked_notes ?? false
		})),
	blocked: done
		.filter((r) => r.outcome === 'blocked')
		.map((r) => ({ menu: r.menu, detail: r.detail })),
	failed: batch.length - done.length + done.filter((r) => r.outcome === 'extract_failed').length,
	// Source-change gate re-baseline (scripts/menu-fingerprint/): every menu that
	// was refreshed needs fresh fingerprints so the next `bun run menu:check` can
	// prove it unchanged. The orchestrator runs this AFTER the workflow.
	baseline_next:
		done.filter((r) => r.outcome === 'refreshed').length > 0
			? `bun run menu:baseline ${done
					.filter((r) => r.outcome === 'refreshed')
					.map((r) => r.menu.menu_id)
					.join(' ')}`
			: null
};
log(
	`Done: ${report.refreshed.length} refreshed, ${report.staged_closures.length} closure(s) staged, ${report.incomplete.length} incomplete, ${report.blocked.length} blocked, ${report.failed} failed`
);
return report;
