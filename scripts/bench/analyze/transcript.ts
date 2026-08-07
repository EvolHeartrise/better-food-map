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
	/**
	 * Which pass produced this event on a multi-pass run; absent on a single-pass
	 * run or one predating harnesses. Without it the timeline silently interleaves
	 * two agents' turns as if they were one conversation.
	 */
	pass?: number;
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
			response_id: str(event.response_id),
			pass: num(event.pass)
		};
		return turn;
	});
}

/**
 * Distinct URLs the model asked `fetch_page` for, in first-request order.
 *
 * `pass` narrows it to one pass of a multi-pass run. Unfiltered, the union of
 * both passes is what the run as a whole opened — correct for "did this SETUP
 * reach every page", but useless for the question the two-pass harness exists to
 * ask: did the REVIEW pass find a page the extractor missed? A union answers yes
 * to both, so the per-pass split is what makes the hypothesis measurable.
 */
export function fetchedUrls(events: readonly Record<string, unknown>[], pass?: number): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const event of events) {
		if (str(event.type) !== 'tool_call') continue;
		if (pass !== undefined && num(event.pass) !== pass) continue;
		const url = toolCallUrl(event);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		out.push(url);
	}
	return out;
}

/** The distinct pass numbers a transcript recorded, ascending; [] when unstamped. */
export function transcriptPasses(events: readonly Record<string, unknown>[]): number[] {
	const seen = new Set<number>();
	for (const event of events) {
		const p = num(event.pass);
		if (p !== undefined) seen.add(p);
	}
	return [...seen].toSorted((a, b) => a - b);
}

/**
 * Menu-shaped URL words — an ORDERING HINT ONLY, never a denominator.
 *
 * There is no reliable way to tell a menu page from its URL. New York Fries
 * serves its menu from `/fries`, `/poutine`, `/premiumdogs` and `/dips`, and
 * Wooden Spoon puts its daily menu at `/daily-features/`: recognizing those
 * needs world knowledge that a word list does not have. An earlier version of
 * this module reported a `menu_ratio` built on this vocabulary, which scored a
 * run that opened only `/menu` — and skipped all five real New York Fries menu
 * pages — at a perfect 100%. That is a confidently WRONG number, which is worse
 * than no number, so the ratio is gone.
 *
 * What survives is exact: `visited / available` over every recorded page, plus
 * the list of pages never opened. This vocabulary only sorts that list, so the
 * likely-relevant entries surface first. A miss here costs a reader one extra
 * line to scan; it can no longer produce a false claim.
 *
 * Whole-token matching (not the recorder's substring regex) is still the right
 * call for sorting: substring matching put `/locations/eaton-centre` at the top
 * of the list because "eaton" contains "eat".
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

/**
 * True when a token of the URL's path is a menu word. A SORT HINT — see the
 * note above: a false negative here is routine and harmless by design.
 */
export function hasMenuWord(url: string): boolean {
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
	/**
	 * `visited / available`. Exact, but NOT a quality score: a venue's recorded
	 * pages include its privacy policy and careers page, which a good extraction
	 * has no reason to open. The actionable output is `unvisited`, not this ratio.
	 */
	ratio: number;
	/**
	 * Recorded pages never fetched — the blind-spot list. Sorted with
	 * menu-word URLs first as a reading hint only (see `hasMenuWord`); a page
	 * without a menu word can still be a menu page, so read the whole list.
	 */
	unvisited: string[];
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

	const availableNorms = new Set(available.map((page) => page.norm));
	const offManifest = fetched.filter((url) => {
		const norm = safeNormalize(url);
		return norm !== null && !availableNorms.has(norm);
	});

	const sortMenuFirst = (a: { url: string }, b: { url: string }) => {
		const aMenu = hasMenuWord(a.url) ? 0 : 1;
		const bMenu = hasMenuWord(b.url) ? 0 : 1;
		return aMenu - bMenu || a.url.localeCompare(b.url);
	};

	return {
		available: available.length,
		visited: visited.length,
		ratio: available.length === 0 ? 1 : visited.length / available.length,
		unvisited: unvisited.toSorted(sortMenuFirst).map((page) => page.url),
		off_manifest: [...new Set(offManifest)].toSorted()
	};
}
