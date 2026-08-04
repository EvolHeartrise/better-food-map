/**
 * Transcript analysis: turn timeline + page-discovery coverage.
 *
 * `transcript.jsonl` holds one event per request/response and tool call/result.
 * Two things fall out of it that the scorer cannot see:
 *
 * - **Where the time and money went.** Per-turn latency, tokens, cache reads and
 *   cost, so a slow run can be attributed to long turns vs many turns.
 * - **Whether the model ever LOOKED at the whole menu.** The `fetch_page` URL
 *   sequence is the model's navigation path. Compared against the pages the
 *   snapshot actually recorded, it measures page-discovery coverage — the exact
 *   failure the data policy calls the classic tell (a venue's menu missing its
 *   entire drinks or desserts page because a nav link was never enumerated).
 *   A model can score well on items while never opening a page; that is luck,
 *   and this makes it visible.
 */
import { normalizeUrl, type BenchManifest } from '../snapshot-store';

export interface TurnEvent {
	type: string;
	ts: string;
	/** Milliseconds since the previous event. Null on the first event. */
	delta_ms: number | null;
	/** tool_call / tool_result only. */
	tool?: string;
	/** fetch_page's requested URL, when this is one. */
	url?: string;
	/** response only, when the provider reported usage. */
	prompt_tokens?: number;
	completion_tokens?: number;
	cached_tokens?: number;
	reasoning_tokens?: number;
	cost?: number;
	/** response only — OpenRouter's upstream provider and generation id. */
	provider?: string;
	response_id?: string;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Pull `fetch_page`'s url out of a tool_call's JSON-string arguments. */
export function toolCallUrl(event: Record<string, unknown>): string | undefined {
	if (str(event.name) !== 'fetch_page') return undefined;
	const args = event.arguments;
	if (typeof args !== 'string') return obj(args) ? str(obj(args)?.url) : undefined;
	try {
		const parsed: unknown = JSON.parse(args);
		return str(obj(parsed)?.url);
	} catch {
		return undefined;
	}
}

export function buildTimeline(events: readonly Record<string, unknown>[]): TurnEvent[] {
	let previous: number | null = null;
	return events.map((event) => {
		const ts = str(event.ts) ?? '';
		const at = ts ? Date.parse(ts) : Number.NaN;
		const delta = previous !== null && Number.isFinite(at) ? at - previous : null;
		if (Number.isFinite(at)) previous = at;

		const usage = obj(event.usage);
		const promptDetails = obj(usage?.prompt_tokens_details);
		const completionDetails = obj(usage?.completion_tokens_details);

		const turn: TurnEvent = {
			type: str(event.type) ?? 'unknown',
			ts,
			delta_ms: delta,
			tool: str(event.name),
			url: toolCallUrl(event),
			prompt_tokens: num(usage?.prompt_tokens),
			completion_tokens: num(usage?.completion_tokens),
			cached_tokens: num(promptDetails?.cached_tokens),
			reasoning_tokens: num(completionDetails?.reasoning_tokens),
			cost: num(usage?.cost),
			provider: str(event.provider),
			response_id: str(event.response_id)
		};
		return turn;
	});
}

/** Distinct URLs the model asked `fetch_page` for, in first-request order. */
export function fetchedUrls(events: readonly Record<string, unknown>[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const event of events) {
		if (str(event.type) !== 'tool_call') continue;
		const url = toolCallUrl(event);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		out.push(url);
	}
	return out;
}

/**
 * Menu-shaped URL words.
 *
 * The recorder matches the same vocabulary as a loose SUBSTRING regex, which is
 * right for its job (prioritizing a crawl — a false positive just reorders a
 * queue). It is wrong here: this classification drives a "menu page never
 * opened" claim, and substring matching turns
 * `/locations/eaton-centre` into a missed menu page because "eaton" contains
 * "eat". So match whole path TOKENS instead — `/drink-menu/` tokenizes to
 * `drink`,`menu` and still hits, while `eaton` never equals `eat`.
 */
const MENU_WORDS = new Set([
	'menu',
	'menus',
	'food',
	'foods',
	'drink',
	'drinks',
	'beverage',
	'beverages',
	'wine',
	'wines',
	'beer',
	'beers',
	'cocktail',
	'cocktails',
	'dessert',
	'desserts',
	'brunch',
	'lunch',
	'dinner',
	'breakfast',
	'order',
	'ordering',
	'eat',
	'takeout',
	'take',
	'catering',
	'nutrition',
	'allergen',
	'allergens'
]);

/** True when any token of the URL's path is a menu word. */
export function isMenuShaped(url: string): boolean {
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		path = url;
	}
	return path
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.some((token) => MENU_WORDS.has(token));
}

export interface PageCoverage {
	/** Pages the snapshot recorded (the model's reachable universe). */
	available: number;
	/** Recorded pages the model actually fetched. */
	visited: number;
	ratio: number;
	/** Recorded but never fetched, menu-shaped ones first — the likely blind spots. */
	unvisited: string[];
	/** Menu-shaped subset, the number that actually matters for exhaustiveness. */
	menu_available: number;
	menu_visited: number;
	menu_ratio: number;
	/** Menu-shaped pages the model never opened. */
	menu_unvisited: string[];
	/** Fetches that hit nothing in the recorded page list (APIs, assets, guesses). */
	off_manifest: string[];
}

function safeNormalize(url: string): string | null {
	try {
		return normalizeUrl(url);
	} catch {
		return null;
	}
}

/**
 * Compare what the model fetched against what the snapshot holds.
 *
 * Only NAVIGATED pages (`manifest.pages`) count as the denominator — the
 * snapshot also holds every asset and API response, and holding a model to
 * fetching CSS would be meaningless. An off-manifest fetch is not a failure
 * either: hitting the ordering API directly is often the RIGHT move, so those
 * are reported separately rather than penalized.
 */
export function pageCoverage(
	manifest: BenchManifest | undefined,
	fetched: readonly string[]
): PageCoverage | null {
	if (!manifest?.pages?.length) return null;

	const fetchedNorm = new Set(
		fetched.map((url) => safeNormalize(url)).filter((url): url is string => url !== null)
	);
	const available = manifest.pages
		.map((page) => ({ url: page.url, norm: safeNormalize(page.url) }))
		.filter((page): page is { url: string; norm: string } => page.norm !== null);

	const visited = available.filter((page) => fetchedNorm.has(page.norm));
	const unvisited = available.filter((page) => !fetchedNorm.has(page.norm));
	const menuPages = available.filter((page) => isMenuShaped(page.url));
	const menuVisited = menuPages.filter((page) => fetchedNorm.has(page.norm));
	const menuUnvisited = menuPages.filter((page) => !fetchedNorm.has(page.norm));

	const availableNorms = new Set(available.map((page) => page.norm));
	const offManifest = fetched.filter((url) => {
		const norm = safeNormalize(url);
		return norm !== null && !availableNorms.has(norm);
	});

	const sortMenuFirst = (a: { url: string }, b: { url: string }) => {
		const aMenu = isMenuShaped(a.url) ? 0 : 1;
		const bMenu = isMenuShaped(b.url) ? 0 : 1;
		return aMenu - bMenu || a.url.localeCompare(b.url);
	};

	return {
		available: available.length,
		visited: visited.length,
		ratio: available.length === 0 ? 1 : visited.length / available.length,
		unvisited: unvisited.toSorted(sortMenuFirst).map((page) => page.url),
		menu_available: menuPages.length,
		menu_visited: menuVisited.length,
		menu_ratio: menuPages.length === 0 ? 1 : menuVisited.length / menuPages.length,
		menu_unvisited: menuUnvisited.map((page) => page.url).toSorted(),
		off_manifest: [...new Set(offManifest)].toSorted()
	};
}
