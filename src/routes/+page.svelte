<script lang="ts">
	import { resolve } from '$app/paths';
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { MediaQuery, SvelteSet, SvelteMap } from 'svelte/reactivity';
	import {
		getLocations,
		getLocationData,
		searchLocations,
		getBrands,
		getStats,
		getUserLocation
	} from '$lib/data.remote';
	import { getCurrentUser, getLikes, setLocationLiked, setItemLiked } from '$lib/user.remote';
	import { getDiet, setDiet } from '$lib/profile.remote';
	import LocationMap from '$lib/components/LocationMap.svelte';
	import MapStatsOverlay from '$lib/components/MapStatsOverlay.svelte';
	import DietSelector from '$lib/components/DietSelector.svelte';
	import FoodTag from '$lib/components/FoodTag.svelte';
	import AccountMenu from '$lib/components/AccountMenu.svelte';
	import LikeButton from '$lib/components/LikeButton.svelte';
	import Search from '@lucide/svelte/icons/search';
	import { categoryLabel, type Category } from '$lib/category';
	import type { MapData, MapLocation, Item, Bounds } from '$lib/server/db';

	// The visible map area, reported by <LocationMap> (debounced) as the user pans
	// and zooms, plus once on load. This is the ONLY thing that decides which data
	// we fetch — the area filter is now "whatever's on screen". Null until the map
	// has mounted and reported its opening view.
	let viewport = $state<Bounds | null>(null);

	// The server caps each viewport read at this many locations (see
	// MAP_RESULT_LIMIT in $lib/server/db). That cap — not a minimum zoom — is what
	// keeps a zoomed-out box from pulling an unbounded set: there is no longer any
	// zoom floor, so every viewport fetches, however far out. Mirrored here only to
	// label a capped result set in the UI; the server stays the source of truth.
	const MAX_RESULTS = 200;

	// --- Search filters --------------------------------------------------------
	// Independent inputs. `place` filters venues by name; `item` (free text) and the
	// dietary selector filter menu items; they combine with AND. With ANY of them set
	// the search goes GLOBAL — the whole index, nearest first (see the search effect
	// below) — rather than narrowing only what's on screen; cleared, the map returns
	// to browsing the current viewport. The dietary selector is single-select: an
	// item must carry the chosen dietary tag (vegan, gluten_free, …).
	let place = $state('');
	let item = $state('');
	// The chosen dietary tag id, or null for "any diet" (no diet filter).
	let diet = $state<string | null>(null);

	// --- Saved diet (the selector IS the profile) ------------------------------
	// A signed-in user's saved diet is loaded once and PRE-APPLIED as the starting
	// filter; changing the selector both applies it and persists it (see selectDiet).
	// Read via `.current` (non-suspending) so the map renders immediately, and seeded
	// only ONCE so a later in-session change isn't clobbered by the resolved resource.
	const savedDietResource = getDiet();
	let dietSeeded = false;
	$effect(() => {
		if (dietSeeded) return;
		const saved = savedDietResource.current;
		if (saved === undefined) return; // still loading
		diet = saved;
		dietSeeded = true;
	});

	// Applies a diet selection and persists it for the signed-in user. Called only on
	// a user action (not the initial seed), so it never echoes the loaded value back.
	// For an anonymous visitor the choice is session-local — the selector still applies
	// it, but there's no profile to save it to, so the persist call is skipped.
	function selectDiet(id: string | null): void {
		diet = id;
		if (user) setDiet(id).catch(() => {});
	}

	// The filters, normalised once and shared by the results list, the selected-
	// location menu and the global-search effect so they all agree on what
	// "matches". `hasItemFilter` is true when any item/diet filter is active;
	// `hasQuery` also counts the place filter and is what flips browse → search.
	const itemTerm = $derived(item.trim().toLowerCase());
	const hasItemFilter = $derived(itemTerm !== '' || diet !== null);
	const hasQuery = $derived(place.trim() !== '' || hasItemFilter);

	// --- Map data --------------------------------------------------------------
	// Two payloads, each updated imperatively (rather than via an awaited $derived)
	// so the markers already on screen stay put while the next set loads — the map
	// never blanks. `viewportData` is what's in the current box (browse mode);
	// `searchData` is the global nearest-first result set (search mode, null until
	// the first search for a query returns). `activeData` picks between them.
	const EMPTY_MAP_DATA: MapData = { locations: [], menus: {}, menuMeta: {} };
	let viewportData = $state<MapData>(EMPTY_MAP_DATA);
	let searchData = $state<MapData | null>(null);

	// Browse mode only: load the visible box. Skipped while a query is active — the
	// search effect below owns the data then — and resumed (against wherever the map
	// now sits) the moment the query is cleared.
	$effect(() => {
		if (hasQuery || !viewport) return;
		const bounds = viewport;
		let cancelled = false;
		getLocations(bounds).then((data) => {
			if (!cancelled) viewportData = data;
		});
		return () => {
			cancelled = true;
		};
	});

	// The map centre — the anchor "nearest" is measured from — as its midpoint, with
	// a default before the first viewport is reported. Read non-reactively inside the
	// search effect's timer, so panning alone never re-runs a search; only changing
	// the query does.
	const DEFAULT_CENTER: [number, number] = [49.2827, -123.1207];
	function mapCenter(): { lat: number; lng: number } {
		if (!viewport) return { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };
		return {
			lat: (viewport.minLat + viewport.maxLat) / 2,
			lng: (viewport.minLng + viewport.maxLng) / 2
		};
	}

	// Whether a point already falls within the (padded) reported viewport — used to
	// decide if a search's nearest match needs the camera flown to it at all.
	function withinViewport(loc: { latitude: number; longitude: number }): boolean {
		if (!viewport) return false;
		return (
			loc.latitude >= viewport.minLat &&
			loc.latitude <= viewport.maxLat &&
			loc.longitude >= viewport.minLng &&
			loc.longitude <= viewport.maxLng
		);
	}

	// A point to fly the map to (the nearest match); null leaves the camera alone.
	// Set by the search effect only when the nearest result is off screen, so a
	// search whose matches are already in view doesn't yank the camera. `key` is a
	// monotonic nonce so <LocationMap> flies exactly once per assignment — even when
	// two consecutive searches happen to target the same coordinates.
	let focusTarget = $state<{ latitude: number; longitude: number; key: string } | null>(null);
	let focusNonce = 0;
	// Debounce before a global search hits the server, so a burst of keystrokes
	// settles into one request.
	const SEARCH_DEBOUNCE_MS = 250;
	// The query, reduced to a stable string — the ONLY reactive trigger for the
	// search effect, so the map centre (read inside the timer) can change with a pan
	// without re-running the search. Each distinct query runs (and flies) once; an
	// unchanged query never re-fires the effect.
	const querySignature = $derived(JSON.stringify({ place: place.trim(), item: itemTerm, diet }));

	// Search mode: run a global, nearest-first search whenever the QUERY changes. On
	// each query's result, fly to the nearest match unless it's already on screen.
	// Clearing the query drops back to browse mode.
	$effect(() => {
		if (!hasQuery) {
			searchData = null;
			return;
		}
		// Read the signature so the effect re-runs when (and only when) the query
		// changes; the value itself isn't otherwise needed.
		void querySignature;
		let cancelled = false;
		const timer = setTimeout(() => {
			const center = mapCenter();
			searchLocations({
				place: place.trim(),
				item: itemTerm,
				dietTagId: diet,
				lat: center.lat,
				lng: center.lng
			}).then((data) => {
				if (cancelled) return;
				searchData = data;
				// The server returns nearest-first, so [0] is the closest match.
				const nearest = data.locations[0];
				if (nearest && !withinViewport(nearest)) {
					focusNonce += 1;
					focusTarget = {
						latitude: nearest.latitude,
						longitude: nearest.longitude,
						key: String(focusNonce)
					};
				}
			});
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	// The data the page renders from: the global search set while a query is active
	// (falling back to the viewport set until the first search returns, so the list
	// filters what's on screen instantly rather than blanking), otherwise the
	// viewport set.
	const activeData = $derived(hasQuery ? (searchData ?? viewportData) : viewportData);

	// True when the active set hit the server's result cap (MAX_RESULTS): the box
	// (browse) or the index (search) held more matches than one read returns. Drives
	// the "zoom in" / "refine" hint so the cap isn't silent.
	const capped = $derived(activeData.locations.length >= MAX_RESULTS);

	// The map page works against each location's fully-resolved `menu`, but the wire
	// payload sends each menu only once (keyed by menu_id) instead of copying it onto
	// every branch that serves it. Rebuild the effective menu here: the items of the
	// location's menu (its own private menu, or a shared brand menu) with this
	// location's per-item overrides applied — items marked unavailable dropped,
	// overridden prices used — and attach the menu's `last_verified` freshness date.
	// Shared by the in-view set below and the by-id detail fetch.
	function resolveLocation(loc: MapLocation, data: MapData): LocationData {
		const menu: Item[] = [];
		if (loc.menu_id) {
			const overrideByItem = new Map(loc.overrides.map((o) => [o.item_id, o]));
			for (const menuItem of data.menus[loc.menu_id] ?? []) {
				const override = overrideByItem.get(menuItem.id);
				if (override?.available === false) continue; // not served at this branch
				// Reuse the shared item object unless this branch overrides its price.
				if (override !== undefined && override.price !== null) {
					menu.push({ ...menuItem, price: override.price });
				} else {
					menu.push(menuItem);
				}
			}
		}
		const lastVerified = loc.menu_id ? (data.menuMeta[loc.menu_id]?.last_verified ?? null) : null;
		return { ...loc, menu, lastVerified };
	}

	const locations = $derived(activeData.locations.map((loc) => resolveLocation(loc, activeData)));

	// Chain/brand records, used only to label deduped result groups with the brand
	// name ("KFC") rather than a single branch's `name`. Keyed by id for lookup.
	const brands = $derived(await getBrands());
	const brandsById = $derived(new Map(brands.map((brand) => [brand.id, brand])));

	// --- Landing: zoomed-out globe + stats overlay ----------------------------
	// The map is public and opens on the fully zoomed-out globe (WORLD_ZOOM). A landing
	// overlay floats over it with our coverage totals and the entry buttons. The landing
	// is driven by ZOOM, not a one-way dismissal: it shows whenever the map is zoomed out
	// onto the globe with no location open, and it RETURNS if the user zooms back out (see
	// `landing`, declared once `selectedId` is in scope).
	const WORLD_ZOOM = 1.5;
	// Orient the opening globe over North America — where coverage is concentrated
	// (Canada first) — so the backdrop markers are in view on the landing.
	const WORLD_CENTER: [number, number] = [45, -95];
	// At or below this zoom the map reads as "the globe" and the landing shows; above it
	// the app UI (search, results) takes over. "Start using" flies past this threshold,
	// and zooming the globe in/out crosses it to leave/return to the landing.
	const LANDING_MAX_ZOOM = 3;

	// The live map zoom, reported by <LocationMap>. Null until the map first reports it;
	// treated as zoomed-out until then (the map opens at WORLD_ZOOM).
	let zoomLevel = $state<number | null>(null);

	// Coverage totals for the overlay, read non-suspending (`.current`) so the map
	// paints immediately and the figures fill in when the count query resolves.
	const statsResource = getStats();
	const stats = $derived(statsResource.current ?? null);

	// "Start using the map": fly to the visitor's IP-detected location at city zoom, which
	// leaves the landing (the zoom passes LANDING_MAX_ZOOM). getUserLocation is prompt-free
	// edge geolocation — null under local dev or when unavailable, so we fall back to the
	// default centre. The fly reuses the search focus channel (a fresh nonce flies exactly
	// once); with no `zoom` override it pulls in to a city view.
	async function startUsing(): Promise<void> {
		const loc = await getUserLocation();
		const target = loc ?? { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };
		focusNonce += 1;
		focusTarget = { latitude: target.lat, longitude: target.lng, key: String(focusNonce) };
	}

	// A location with its effective menu resolved (see resolveLocation), plus its
	// menu's `last_verified` freshness date (null for unverified/private menus).
	type LocationData = MapLocation & { menu: Item[]; lastVerified: string | null };

	// On narrow (mobile) screens the row of floating search items collapses behind a
	// "Filters" toggle so the map isn't crowded. Open by default so the filters stay
	// discoverable; the toggle (shown only on narrow screens, via CSS) lets the user
	// reclaim the map. The wide layout always shows the items and hides the toggle,
	// so this flag is inert there.
	let filtersOpen = $state(true);

	// Price formatters, one per ISO-4217 currency code (each item carries its menu's
	// currency), built lazily and cached so a mixed-currency result set still formats
	// every price in its own currency rather than a single hard-coded one. A plain
	// record, not a Map — it's a non-reactive memo cache, never component state.
	const moneyFormatters: Record<string, Intl.NumberFormat> = {};
	function moneyFormatter(code: string): Intl.NumberFormat {
		return (moneyFormatters[code] ??= new Intl.NumberFormat('en-CA', {
			style: 'currency',
			currency: code
		}));
	}

	function itemMatches(menuItem: Item): boolean {
		if (itemTerm !== '' && !menuItem.item_name.toLowerCase().includes(itemTerm)) return false;
		// Diet filter: the item must carry the chosen dietary tag. Mirrors the
		// server's per-item predicate in getSearchMapData.
		if (diet !== null && !menuItem.tags.some((tag) => tag.id === diet)) return false;
		return true;
	}

	// One entry per location to show, paired with the menu items that matched. The
	// candidate set is whatever is currently visible on the map (`locations`), so
	// with no filter active every visible place is listed; the inputs only narrow
	// it. Item-level inputs drive the per-card list; with none active, `items` is
	// empty and the card shows no list (the Place box just narrows venues).
	const results = $derived.by(() => {
		const placeTerm = place.trim().toLowerCase();

		const out: Array<{ loc: LocationData; items: Item[] }> = [];
		for (const loc of locations) {
			if (placeTerm !== '' && !loc.name.toLowerCase().includes(placeTerm)) continue;
			if (!hasItemFilter) {
				out.push({ loc, items: [] });
				continue;
			}
			const items = loc.menu.filter(itemMatches);
			if (items.length > 0) {
				out.push({ loc, items });
			}
		}
		return out;
	});

	// The map always plots EVERY matching location — grouping is a results-list
	// concern only. A 30-branch chain still drops 30 markers; the list just shows
	// one "KFC — 30 locations" card in their place.
	const mapLocations = $derived(results.map((result) => result.loc));

	// --- Result grouping (chain dedup) ----------------------------------------
	// Branches of the same chain share a `menu_id` (they serve one menu), so a
	// search like "kfc" otherwise floods the list with hundreds of identical
	// cards. We collapse locations that share a `menu_id` into a single group
	// labelled with the brand name and branch count; everything else (independent
	// venues, and one-off chains with a single matching branch) stays a plain card.
	type ResultEntry = { loc: LocationData; items: Item[] };
	type SingleResult = { kind: 'single'; key: string; loc: LocationData; items: Item[] };
	type GroupResult = {
		kind: 'group';
		key: string; // the shared menu_id
		name: string; // brand name, e.g. "KFC"
		category: Category | null;
		members: ResultEntry[];
		// Matched menu items for the group. Every branch serves the same menu, so
		// the item-filter matches are identical across members — show them once.
		items: Item[];
	};
	type DisplayResult = SingleResult | GroupResult;

	const groupedResults = $derived.by<DisplayResult[]>(() => {
		const out: DisplayResult[] = [];
		// Plain scratch object (not a Map) so the no-mutable-Map lint rule stays
		// happy — it's transient, never reactive state.
		const groupByMenu: Record<string, GroupResult> = {};
		for (const entry of results) {
			const menuId = entry.loc.menu_id;
			// No shared menu → an independent venue; never grouped.
			if (menuId === null) {
				out.push({ kind: 'single', key: entry.loc.id, loc: entry.loc, items: entry.items });
				continue;
			}
			let group = groupByMenu[menuId];
			if (!group) {
				const brandName = entry.loc.brand_id ? brandsById.get(entry.loc.brand_id)?.name : undefined;
				group = {
					kind: 'group',
					key: menuId,
					name: brandName ?? entry.loc.name,
					category: entry.loc.category,
					members: [],
					items: entry.items
				};
				groupByMenu[menuId] = group;
				// Position the group where its first branch would have appeared, so the
				// name-ordered list keeps its ordering.
				out.push(group);
			}
			group.members.push({ loc: entry.loc, items: entry.items });
		}
		// A group with a single matching branch adds an extra click for no benefit —
		// render it as a normal card instead.
		return out.map((result) =>
			result.kind === 'group' && result.members.length === 1
				? {
						kind: 'single',
						key: result.members[0].loc.id,
						loc: result.members[0].loc,
						items: result.members[0].items
					}
				: result
		);
	});

	// Which chain groups are expanded to reveal their individual branches, keyed by
	// group key (menu_id). A reactive set so toggling re-renders.
	const expandedGroups = new SvelteSet<string>();

	function toggleGroup(key: string): void {
		if (expandedGroups.has(key)) expandedGroups.delete(key);
		else expandedGroups.add(key);
	}

	// --- Selected location (integrated detail view) ---------------------------
	// The open location is driven by shallow routing: selecting pushes a
	// `/map/locations/<id>` history entry (without navigating) that carries the id
	// in `page.state`, so Back closes the detail.
	//
	// On a fresh load or shared link `page.state` is empty (shallow-routing state
	// isn't restored after a hard navigation), so the id comes from the URL — the
	// `reroute` hook serves this page for `/locations/*`. We snapshot that landing
	// id ONCE instead of reading `page.url` reactively: `pushState`/`replaceState`
	// update only the address bar and `page.state`, never `page.url`. A live
	// `idFromPath(page.url.pathname)` would therefore stay pinned to the landing id
	// for the whole session and re-open the detail every time the selection state
	// is cleared — so closing must also null this snapshot (see `closeDetail`).
	let landingId = $state(idFromPath(page.url.pathname));
	const selectedId = $derived(page.state.selected ?? landingId);

	// True while the landing should show (see the WORLD_ZOOM block): the map is zoomed out
	// onto the globe with nothing open. An open location (including a `/locations/<id>`
	// deep link, via `selectedId`) always takes precedence, and zooming back out brings the
	// landing back. While it's up, the search controls and results list are hidden so the
	// globe and the two floating landing pieces are all that show.
	const landing = $derived(!selectedId && (zoomLevel === null || zoomLevel <= LANDING_MAX_ZOOM));

	// The resolved record for the open location. Because we now load only the
	// visible area, the selected place isn't always among `locations` — a shared
	// `/locations/<id>` link, or one panned off screen, falls outside it. So we
	// resolve it from the in-view set when present and otherwise fetch it by id.
	// Held in state (not a derived) and updated imperatively so the open detail
	// stays put while a by-id fetch is in flight — panning the place off screen
	// doesn't flash the panel closed.
	let selectedLocation = $state<LocationData | null>(null);
	$effect(() => {
		const id = selectedId;
		if (!id) {
			selectedLocation = null;
			return;
		}
		const inView = locations.find((loc) => loc.id === id) ?? null;
		if (inView) {
			selectedLocation = inView;
			return;
		}
		// Out of view: fetch it on its own. getLocationData dedupes by id, so a
		// refetch triggered by a subsequent pan won't hit the network again. We
		// leave any currently-shown detail in place until this resolves.
		let cancelled = false;
		getLocationData(id).then((data) => {
			if (cancelled) return;
			const loc = data.locations[0];
			selectedLocation = loc ? resolveLocation(loc, data) : null;
		});
		return () => {
			cancelled = true;
		};
	});

	// The menu shown in the detail panel for the selected location. The same
	// item/dietary filters that narrow the results list apply here too;
	// with none active (`hasItemFilter` false) the full menu is shown.
	const detailMenu = $derived.by<Item[]>(() => {
		if (!selectedLocation) return [];
		if (!hasItemFilter) return selectedLocation.menu;
		return selectedLocation.menu.filter(itemMatches);
	});

	function idFromPath(pathname: string): string | null {
		const match = pathname.match(/\/locations\/([^/]+)$/);
		return match ? decodeURIComponent(match[1]) : null;
	}

	function selectLocation(id: string): void {
		// Selecting a place (e.g. tapping a marker on the landing globe) sets `selectedId`,
		// which leaves the landing (see `landing`) so the detail panel can show.
		// `/locations/<id>` is a synthetic shallow-routing URL: there is no such route
		// (the `reroute` hook serves this root map page for it), so the address bar can
		// reflect the open location — and the link stays shareable — without a real
		// navigation. Because it isn't a real route it can't go through the typed
		// `resolve(routeId)`, hence the lint exception on the calls below.
		const url = `/locations/${encodeURIComponent(id)}`;
		const state = { selected: id };
		// Reuse the current history entry when switching between locations, so Back
		// always returns to the results list rather than the previously viewed place.
		if (page.state.selected) {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- synthetic shallow URL (see above)
			replaceState(url, state);
		} else {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- synthetic shallow URL (see above)
			pushState(url, state);
		}
	}

	function closeDetail(): void {
		// Drop the landing-id snapshot so a detail opened from a `/locations/<id>`
		// URL actually closes. With `page.state` cleared below, `selectedId` falls
		// back to `landingId`; since `page.url` is frozen at the landing path,
		// `idFromPath` would keep yielding that id, so the snapshot must be cleared
		// too (see the note above the snapshot).
		landingId = null;
		// Rewrite the current history entry to the bare map URL (`/`) with empty state.
		// `replaceState` clears `page.state` and resets the address bar synchronously;
		// together with the line above, `selectedLocation` resolves to `null` at once.
		//
		// We deliberately avoid `history.back()`: it depends on the previous entry
		// being a selection-free results view and on an async `popstate` to reset
		// `page.state`. Neither holds when the page was opened on a `/locations/<id>`
		// link, so Back there could leave the detail open. Pressing the browser Back
		// button still closes the detail via the prior `/` entry, so back/forward
		// stays intuitive.
		replaceState(resolve('/'), {});
	}

	// --- Account & likes -------------------------------------------------------
	// The signed-in user (null when signed out) drives the account control and gates
	// the like buttons. Likes are read only when signed in.
	const user = $derived(await getCurrentUser());
	const serverLikes = $derived(user ? await getLikes() : { locationIds: [], itemIds: [] });

	// Optimistic like state: a pending map of just-toggled ids layered over the
	// server set, so a tap reflects instantly without waiting on the round trip (and
	// reverts if it fails). The pending maps are reactive, so the id sets below
	// recompute as toggles land; a later server reload supersedes the pending entry.
	const pendingLocationLikes = new SvelteMap<string, boolean>();
	const pendingItemLikes = new SvelteMap<string, boolean>();

	function overlayLikes(
		serverIds: string[],
		pending: SvelteMap<string, boolean>
	): SvelteSet<string> {
		const ids = new SvelteSet(serverIds);
		for (const [id, liked] of pending) {
			if (liked) ids.add(id);
			else ids.delete(id);
		}
		return ids;
	}

	const likedLocationIds = $derived(overlayLikes(serverLikes.locationIds, pendingLocationLikes));
	const likedItemIds = $derived(overlayLikes(serverLikes.itemIds, pendingItemLikes));

	function toggleLocationLike(id: string) {
		const liked = likedLocationIds.has(id);
		pendingLocationLikes.set(id, !liked);
		setLocationLiked({ locationId: id, liked: !liked }).catch(() =>
			pendingLocationLikes.set(id, liked)
		);
	}

	function toggleItemLike(id: string) {
		const liked = likedItemIds.has(id);
		pendingItemLikes.set(id, !liked);
		setItemLiked({ itemId: id, liked: !liked }).catch(() => pendingItemLikes.set(id, liked));
	}

	function formatPrice(price: number | null, code: string): string {
		return price === null ? '—' : moneyFormatter(code).format(price);
	}

	// A short, readable name for a source: its label, else the bare hostname.
	function sourceText(source: { url: string; label: string | null }): string {
		if (source.label) return source.label;
		try {
			return new URL(source.url).hostname.replace(/^www\./, '');
		} catch {
			return source.url;
		}
	}

	// --- Menu freshness --------------------------------------------------------
	// A menu carries a `last_verified` ISO date (the day it was last checked against
	// its source). We surface it as a relative phrase so a stale chain menu reads as
	// such; past this many days it's flagged as possibly out of date.
	const VERIFIED_STALE_DAYS = 180;
	function verifiedDaysAgo(iso: string): number | null {
		const then = new Date(iso).getTime();
		if (Number.isNaN(then)) return null;
		return Math.floor((Date.now() - then) / 86_400_000);
	}
	function formatVerified(iso: string): string {
		const days = verifiedDaysAgo(iso);
		if (days === null) return `Verified ${iso}`;
		if (days <= 0) return 'Verified today';
		if (days === 1) return 'Verified yesterday';
		if (days < 30) return `Verified ${days} days ago`;
		const months = Math.round(days / 30);
		if (months < 12) return `Verified ${months} month${months === 1 ? '' : 's'} ago`;
		const years = Math.round(days / 365);
		return `Verified ${years} year${years === 1 ? '' : 's'} ago`;
	}
	function verifiedIsStale(iso: string): boolean {
		const days = verifiedDaysAgo(iso);
		return days !== null && days > VERIFIED_STALE_DAYS;
	}

	// --- Menu item details popup ----------------------------------------------
	// The menu list shows only name, price and description; hovering a row (or,
	// on touch, tapping it) reveals the full details — dietary/course tags and data
	// sources included — in a popup that floats to the left of the row,
	// over the map. It's rendered once at the page root and positioned `fixed` so
	// it escapes the results panel's `overflow: hidden`.
	const POPUP_GAP = 12;

	let activeMenuItemId = $state<string | null>(null);
	// Coordinates for the wide-screen (left-anchored) layout; ignored when narrow.
	let popupTop = $state(0);
	let popupRight = $state(0);
	let popupEl = $state<HTMLElement>();
	// The row that opened the popup, kept so it can be re-measured on scroll/resize.
	let activeAnchorEl: HTMLElement | null = null;
	// Below 48rem the results panel is a full-width bottom sheet, so there's no
	// room beside a row: the popup switches to a card pinned above the sheet.
	const narrowViewport = new MediaQuery('(max-width: 48rem)');

	const activeMenuItem = $derived(
		activeMenuItemId === null
			? null
			: (detailMenu.find((menuItem) => menuItem.id === activeMenuItemId) ?? null)
	);

	function anchorMenuPopup(anchor: HTMLElement): void {
		activeAnchorEl = anchor;
		const rect = anchor.getBoundingClientRect();
		popupTop = rect.top;
		// The popup's right edge sits a small gap to the left of the row.
		popupRight = window.innerWidth - rect.left + POPUP_GAP;
	}

	function openMenuPopup(id: string, anchor: HTMLElement): void {
		activeMenuItemId = id;
		anchorMenuPopup(anchor);
	}

	function closeMenuPopup(): void {
		activeMenuItemId = null;
		activeAnchorEl = null;
	}

	// Mice hover to open/close; touch is handled by the click toggle below.
	function handleItemPointerEnter(event: PointerEvent, id: string): void {
		if (event.pointerType !== 'mouse') return;
		openMenuPopup(id, event.currentTarget as HTMLElement);
	}

	function handleItemPointerLeave(event: PointerEvent, id: string): void {
		if (event.pointerType !== 'mouse') return;
		if (activeMenuItemId === id) closeMenuPopup();
	}

	// A click — mouse, a tap on touch, or Enter/Space on the button via keyboard
	// — toggles the popup, which is what gives touch users tap-to-open/close.
	function toggleMenuPopup(id: string, anchor: HTMLElement): void {
		if (activeMenuItemId === id) {
			closeMenuPopup();
		} else {
			openMenuPopup(id, anchor);
		}
	}

	// If the open item drops out of the filtered menu (or the detail closes),
	// dismiss its popup.
	$effect(() => {
		if (activeMenuItemId !== null && activeMenuItem === null) closeMenuPopup();
	});

	// Position the wide-screen popup, clamped to stay within the viewport. The
	// floating popup only renders on wide screens — narrow uses an inline expansion
	// under the row — so `popupEl` is absent on narrow and this effect no-ops there.
	$effect(() => {
		const el = popupEl;
		if (!el || activeMenuItemId === null) return;
		const maxTop = window.innerHeight - el.offsetHeight - POPUP_GAP;
		el.style.top = `${Math.max(POPUP_GAP, Math.min(popupTop, maxTop))}px`;
		el.style.right = `${popupRight}px`;
	});

	// Keep the popup glued to its row while the menu list scrolls or the window
	// resizes. The list scrolls inside the panel, hence capture-phase listening.
	$effect(() => {
		if (activeMenuItemId === null) return;
		function reposition() {
			if (activeAnchorEl) anchorMenuPopup(activeAnchorEl);
		}
		window.addEventListener('scroll', reposition, true);
		window.addEventListener('resize', reposition);
		return () => {
			window.removeEventListener('scroll', reposition, true);
			window.removeEventListener('resize', reposition);
		};
	});

	// A pointerdown outside the popup and its trigger closes it — this is what
	// lets a tap elsewhere dismiss a tapped-open popup on touch.
	$effect(() => {
		if (activeMenuItemId === null) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target as Element | null;
			if (popupEl?.contains(target)) return;
			if (target?.closest('.menu__trigger')) return;
			// Taps inside the narrow inline expansion shouldn't dismiss it.
			if (target?.closest('.menu__details')) return;
			closeMenuPopup();
		}
		window.addEventListener('pointerdown', onPointerDown, true);
		return () => window.removeEventListener('pointerdown', onPointerDown, true);
	});
</script>

<svelte:head>
	<title>BetterFoodMaps</title>
	<meta
		name="description"
		content="Explore cafes, fast food and restaurants around the world on an interactive map."
	/>
</svelte:head>

<div class="app">
	<div class="app__map">
		<LocationMap
			locations={mapLocations}
			selected={selectedLocation}
			onselect={selectLocation}
			initialCenter={WORLD_CENTER}
			initialZoom={WORLD_ZOOM}
			onzoom={(z) => (zoomLevel = z)}
			focus={focusTarget}
			onviewchange={(bounds) => (viewport = bounds)}
		/>
	</div>

	<!-- The landing overlay: coverage stats + entry buttons, shown over the zoomed-out
	     globe. It's zoom-driven (see `landing`): it appears whenever the map is zoomed
	     out and returns if the visitor zooms back out. -->
	{#if landing}
		<MapStatsOverlay {stats} onstart={startUsing} />
	{/if}

	<!-- The search controls don't live in a panel: each is its own pill floating
	     free over the map, laid out as a horizontal row. On narrow screens the row
	     collapses behind the "Filters" toggle. -->
	<div class="searchbar" role="search" aria-label="Search and filters">
		<AccountMenu {user} />

		<!-- Search and filter controls are hidden while the landing overlay is up — the
		     globe is just a backdrop then; only the account control stays. They return
		     the moment the visitor leaves the landing state. -->
		{#if !landing}
			<!-- Shown only on narrow screens (CSS): collapses the items to free the map. -->
			<button
				type="button"
				class="searchbar__toggle"
				aria-expanded={filtersOpen}
				aria-controls="search-items"
				onclick={() => (filtersOpen = !filtersOpen)}
			>
				<span>{filtersOpen ? 'Hide' : 'Filters'}</span>
				{#if !filtersOpen && hasQuery}
					<span class="searchbar__dot" aria-hidden="true"></span>
				{/if}
				<span class="searchbar__toggle-icon" aria-hidden="true">{filtersOpen ? '▴' : '▾'}</span>
			</button>

			<div
				class="searchbar__items"
				id="search-items"
				class:searchbar__items--collapsed={!filtersOpen}
			>
				<!-- Place: a plain search pill, or — once a location is open — a tinted card
			     standing in for it, with a clear (✕) that closes the detail. -->
				{#if selectedLocation}
					{@const placeLabel = categoryLabel(selectedLocation.category)}
					{@const placeMeta = [placeLabel, selectedLocation.address].filter(Boolean).join(' · ')}
					<div class="place-card" aria-label="Selected place">
						<div class="place-card__body">
							<span class="place-card__name">{selectedLocation.name}</span>
							{#if placeMeta}
								<span class="place-card__meta">{placeMeta}</span>
							{/if}
						</div>
						<button
							type="button"
							class="place-card__clear"
							aria-label="Clear selected place"
							onclick={closeDetail}
						>
							✕
						</button>
					</div>
				{:else}
					<!-- A label so a click anywhere in the pill (the search icon included)
				     focuses the input; the input is the only control inside it. -->
					<label class="searchpill">
						<input
							class="searchpill__input"
							type="search"
							placeholder="Place name…"
							aria-label="Search by place name"
							bind:value={place}
						/>
						<Search class="searchpill__icon" size={16} aria-hidden="true" />
					</label>
				{/if}

				<label class="searchpill">
					<input
						class="searchpill__input"
						type="search"
						placeholder="Item name…"
						aria-label="Search by item name"
						bind:value={item}
					/>
					<Search class="searchpill__icon" size={16} aria-hidden="true" />
				</label>

				<!-- The dietary selector: single-select. Filters items to the chosen diet,
			     and persists the choice for the signed-in user (see selectDiet). -->
				<DietSelector value={diet} onSelect={selectDiet} />
			</div>
		{/if}
	</div>

	<!-- The results / detail panel is hidden during the landing state (see `landing`):
	     the zoomed-out globe shows no list, only the floating landing pieces. -->
	<aside
		class="panel panel--results"
		class:panel--hidden={landing}
		aria-label={selectedLocation ? 'Location details' : 'Matching places'}
	>
		{#if selectedLocation}
			{@const label = categoryLabel(selectedLocation.category)}
			{@const selectedLocationId = selectedLocation.id}
			<section class="detail">
				<button type="button" class="detail__back" onclick={closeDetail}>
					← Back to results
				</button>

				<div class="detail__body">
					<header class="detail__header">
						<h2 class="detail__name">{selectedLocation.name}</h2>
						{#if label}
							<span class="badge">{label}</span>
						{/if}
						{#if user}
							<span class="detail__like">
								<LikeButton
									liked={likedLocationIds.has(selectedLocationId)}
									onToggle={() => toggleLocationLike(selectedLocationId)}
									label={likedLocationIds.has(selectedLocationId)
										? 'Unlike this place'
										: 'Like this place'}
									size={18}
								/>
							</span>
						{/if}
					</header>

					{#if selectedLocation.address || selectedLocation.phone || selectedLocation.website || selectedLocation.sources.length > 0}
						<dl class="info">
							{#if selectedLocation.address}
								<div class="info__row">
									<dt>Address</dt>
									<dd>{selectedLocation.address}</dd>
								</div>
							{/if}
							{#if selectedLocation.phone}
								<div class="info__row">
									<dt>Phone</dt>
									<dd><a href="tel:{selectedLocation.phone}">{selectedLocation.phone}</a></dd>
								</div>
							{/if}
							{#if selectedLocation.website}
								<div class="info__row">
									<dt>Website</dt>
									<dd>
										<a
											href={selectedLocation.website}
											target="_blank"
											rel="external noopener noreferrer"
										>
											{selectedLocation.website}
										</a>
									</dd>
								</div>
							{/if}
							{#if selectedLocation.sources.length > 0}
								<div class="info__row">
									<dt>Sources</dt>
									<dd>
										<ul class="info__sources">
											{#each selectedLocation.sources as source (source.url)}
												<li>
													<a href={source.url} target="_blank" rel="external noopener noreferrer">
														{sourceText(source)}
													</a>
												</li>
											{/each}
										</ul>
									</dd>
								</div>
							{/if}
						</dl>
					{/if}

					<section class="menu">
						<div class="menu__head">
							<h3 class="menu__heading">Menu</h3>
							<!-- Freshness signal, shown for every location that has a menu. Every
							     menu carries a verification date (enforced by migration 0012), so
							     there is always a date to show; the pill goes muted+amber once stale. -->
							{#if selectedLocation.menu.length > 0 && selectedLocation.lastVerified}
								<span
									class="menu__verified"
									class:menu__verified--stale={verifiedIsStale(selectedLocation.lastVerified)}
									title={`Menu last verified on ${selectedLocation.lastVerified}`}
								>
									{formatVerified(selectedLocation.lastVerified)}
								</span>
							{/if}
						</div>
						{#if selectedLocation.menu.length === 0}
							<p class="menu__empty">Menu information isn't available for this place yet.</p>
						{:else if detailMenu.length === 0}
							<p class="menu__empty">No menu items match the current filters.</p>
						{:else}
							{#if hasItemFilter}
								<p class="menu__filtered">
									Showing {detailMenu.length} of {selectedLocation.menu.length}
									{selectedLocation.menu.length === 1 ? 'item' : 'items'} matching your filters.
								</p>
							{/if}
							<ul class="menu__list">
								{#each detailMenu as menuItem (menuItem.id)}
									<li class="menu__item" class:menu__item--likeable={!!user}>
										<button
											type="button"
											class="menu__trigger"
											aria-expanded={activeMenuItemId === menuItem.id}
											onpointerenter={(event) => handleItemPointerEnter(event, menuItem.id)}
											onpointerleave={(event) => handleItemPointerLeave(event, menuItem.id)}
											onclick={(event) => toggleMenuPopup(menuItem.id, event.currentTarget)}
										>
											<span class="menu__line">
												<span class="menu__name">{menuItem.item_name}</span>
												<span class="menu__price"
													>{formatPrice(menuItem.price, menuItem.currency)}</span
												>
											</span>
											{#if menuItem.description}
												<span class="menu__description">{menuItem.description}</span>
											{:else}
												<span class="menu__description menu__description--empty"
													>No description</span
												>
											{/if}
										</button>
										<!-- The item's dietary tags, surfaced inline (not hidden behind the
										     hover/tap popup) — the diet markers are what most people scan a
										     menu for. Course tags stay in the popup. -->
										{@render dietaryBadges(menuItem)}
										{#if user}
											<span class="menu__like">
												<LikeButton
													liked={likedItemIds.has(menuItem.id)}
													onToggle={() => toggleItemLike(menuItem.id)}
													label={likedItemIds.has(menuItem.id)
														? `Unlike ${menuItem.item_name}`
														: `Like ${menuItem.item_name}`}
												/>
											</span>
										{/if}
										<!-- No room for the floating popup beside the bottom sheet on narrow screens, so the tapped item's details expand inline instead. -->
										{#if narrowViewport.current && activeMenuItemId === menuItem.id}
											<div class="menu__details">
												{@render itemExtras(menuItem)}
											</div>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				</div>
			</section>
		{:else}
			<section class="results">
				<p class="results__count">
					{results.length}
					{results.length === 1 ? 'place' : 'places'}
					{#if hasQuery}<span class="results__scope">· nearest first</span>{/if}
				</p>

				{#if capped}
					<p class="results__note">
						{#if hasQuery}
							Showing the {MAX_RESULTS} nearest matches — refine your search to narrow it.
						{:else}
							Only the first {MAX_RESULTS} places in view are loaded — zoom in to see the rest.
						{/if}
					</p>
				{/if}

				{#if results.length === 0}
					<p class="results__empty">
						{#if hasQuery && searchData === null}
							Searching the whole map…
						{:else if hasQuery}
							No matches anywhere. Try removing a filter.
						{:else if viewport === null}
							Loading the map…
						{:else}
							No places in this area.
						{/if}
					</p>
				{:else}
					<ul class="results__list">
						{#each groupedResults as result (result.key)}
							{#if result.kind === 'single'}
								{@const label = categoryLabel(result.loc.category)}
								<li>
									<button
										type="button"
										class="card"
										class:card--likeable={!!user}
										onclick={() => selectLocation(result.loc.id)}
									>
										<span class="card__name">{result.loc.name}</span>
										{#if label}
											<span class="card__category">{label}</span>
										{/if}
										{#if result.loc.address}
											<span class="card__address">{result.loc.address}</span>
										{/if}
										{@render matchedItems(result.items)}
									</button>
									{#if user}
										<span class="card__like">
											<LikeButton
												liked={likedLocationIds.has(result.loc.id)}
												onToggle={() => toggleLocationLike(result.loc.id)}
												label={likedLocationIds.has(result.loc.id)
													? `Unlike ${result.loc.name}`
													: `Like ${result.loc.name}`}
											/>
										</span>
									{/if}
								</li>
							{:else}
								{@const label = categoryLabel(result.category)}
								{@const expanded = expandedGroups.has(result.key)}
								<li>
									<!-- Deduped chain: one card standing in for N branches. Clicking it
									     expands the branch list below rather than opening a detail. -->
									<button
										type="button"
										class="card card--group"
										aria-expanded={expanded}
										onclick={() => toggleGroup(result.key)}
									>
										<span class="card__name">
											{result.name}
											<span class="card__count">{result.members.length} locations</span>
										</span>
										{#if label}
											<span class="card__category">{label}</span>
										{/if}
										{@render matchedItems(result.items)}
										<span class="card__expand">
											{expanded ? 'Hide locations' : 'Show locations'}
											<span class="card__expand-icon" aria-hidden="true"
												>{expanded ? '▴' : '▾'}</span
											>
										</span>
									</button>
									{#if expanded}
										<ul class="group__members">
											{#each result.members as member (member.loc.id)}
												<li>
													<button
														type="button"
														class="card card--member"
														class:card--likeable={!!user}
														onclick={() => selectLocation(member.loc.id)}
													>
														{#if member.loc.address}
															<span class="card__address">{member.loc.address}</span>
														{:else}
															<span class="card__address card__address--empty"
																>Address not listed</span
															>
														{/if}
													</button>
													{#if user}
														<span class="card__like">
															<LikeButton
																liked={likedLocationIds.has(member.loc.id)}
																onToggle={() => toggleLocationLike(member.loc.id)}
																label={likedLocationIds.has(member.loc.id)
																	? `Unlike ${result.name}`
																	: `Like ${result.name}`}
															/>
														</span>
													{/if}
												</li>
											{/each}
										</ul>
									{/if}
								</li>
							{/if}
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	</aside>

	<!-- The matched-menu-item list shown under a result card (when an item/dietary
	     filter is active). Shared by plain and chain-group cards. -->
	{#snippet matchedItems(items: Item[])}
		{#if items.length > 0}
			<ul class="card__items">
				{#each items as menuItem (menuItem.id)}
					<li class="card__item">
						<span class="card__item-line">
							<span class="card__item-name">{menuItem.item_name}</span>
							{#if menuItem.price !== null}
								<span class="card__item-price"
									>{moneyFormatter(menuItem.currency).format(menuItem.price)}</span
								>
							{/if}
						</span>
						{@render dietaryBadges(menuItem)}
					</li>
				{/each}
			</ul>
		{/if}
	{/snippet}

	<!-- An item's DIETARY tags (vegan, gluten-free, halal, …) only, rendered inline
	     wherever the item appears so the diet markers are visible at a glance rather
	     than hidden behind the hover/tap popup. Course tags stay in itemExtras.
	     `optional` (e.g. "can be made vegan") keeps its dashed marker. -->
	{#snippet dietaryBadges(menuItem: Item)}
		{@const dietaryTags = menuItem.tags.filter((tag) => tag.tag_type === 'dietary')}
		{#if dietaryTags.length > 0}
			<ul class="taglist taglist--inline">
				{#each dietaryTags as tag (tag.id)}
					<li><FoodTag {tag} optional={tag.optional} /></li>
				{/each}
			</ul>
		{/if}
	{/snippet}

	<!-- Shared by the wide-screen floating popup and the narrow inline expansion:
	     the item's course tag and its data sources. Dietary tags are shown inline on
	     the row itself (see dietaryBadges), so they're omitted here to avoid repeating
	     them. An `optional` tag keeps its dashed marker. -->
	{#snippet itemExtras(menuItem: Item)}
		{@const courseTags = menuItem.tags.filter((tag) => tag.tag_type === 'course')}
		{#if courseTags.length > 0}
			<ul class="taglist">
				{#each courseTags as tag (tag.id)}
					<li><FoodTag {tag} optional={tag.optional} /></li>
				{/each}
			</ul>
		{/if}
		{#if menuItem.sources.length > 0}
			<div class="sources">
				<span class="sources__label">Sources</span>
				<ul class="sources__list">
					{#each menuItem.sources as source (source.url)}
						<li class="source">{sourceText(source)}</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/snippet}

	<!-- Wide screens float the details beside the row; narrow screens render them
	     inline under the row (see the menu list above), so this only mounts on wide. -->
	{#if activeMenuItem && !narrowViewport.current}
		<div class="menu-popup" role="tooltip" bind:this={popupEl}>
			<div class="menu__line">
				<span class="menu__name">{activeMenuItem.item_name}</span>
				<span class="menu__price">{formatPrice(activeMenuItem.price, activeMenuItem.currency)}</span
				>
			</div>
			{#if activeMenuItem.description}
				<span class="menu__description">{activeMenuItem.description}</span>
			{:else}
				<span class="menu__description menu__description--empty">No description</span>
			{/if}
			{@render itemExtras(activeMenuItem)}
		</div>
	{/if}
</div>

<style>
	.app {
		position: fixed;
		inset: 0;
		overflow: hidden;
	}

	/* The map fills the whole viewport. A z-index here establishes a stacking
	   context so the panel (z-index 10) floats above every MapLibre pane/control. */
	.app__map {
		position: absolute;
		inset: 0;
		z-index: 0;
	}

	/* The results panel floats over the map, top-right, capped to the viewport so it
	   never overflows. (The search controls are no longer a panel — see .searchbar.) */
	.panel {
		position: absolute;
		z-index: 10;
		top: calc(1rem + env(safe-area-inset-top));
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		padding: 1rem;
		border-radius: 1rem;
		background: rgba(255, 255, 255, 0.72);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.16);
		max-height: calc(100dvh - 2rem);
	}

	.panel--results {
		right: calc(1rem + env(safe-area-inset-right));
		width: min(22rem, calc(100vw - 2rem));
		/* The list inside scrolls; the panel itself is clipped. */
		overflow: hidden;
	}

	/* Hidden during the landing state, so the zoomed-out globe shows no results list. */
	.panel--hidden {
		display: none;
	}

	/* The search controls, free-floating over the map: a horizontal, wrapping row of
	   independent pills (account, Place, Item, Diet) anchored top-left. No shared
	   surface — each child carries its own glass. The width is
	   capped so the row keeps clear of the results panel on the right; it wraps to a
	   new line before it would run underneath it. */
	.searchbar {
		position: absolute;
		z-index: 10;
		top: calc(1rem + env(safe-area-inset-top));
		left: calc(1rem + env(safe-area-inset-left));
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.5rem;
		/* Use the full width up to the results panel — no fixed cap, or the row would
		   wrap early while space remains. The panel is 22rem wide at a 1rem right inset,
		   so this stops ~2rem short of it (1rem left inset + 22rem panel + 1rem inset +
		   2rem gap = 26rem reserved); the items wrap only when they'd cross that line. */
		max-width: calc(100vw - 26rem);
	}

	/* On wide screens the items flow as direct children of the row (the wrapper is
	   laid out as display: contents so it adds no box of its own); the narrow media
	   query below turns it into its own wrapping row and lets the toggle fold it away. */
	.searchbar__items {
		display: contents;
	}

	/* Collapse control for the items. Hidden on wide screens (which always show the
	   items); the media query at the bottom reveals it on narrow screens, where
	   folding the row hands the map back its space. */
	.searchbar__toggle {
		display: none;
		align-items: center;
		gap: 0.35rem;
		padding: 0.45rem 0.7rem;
		border: 1px solid rgba(255, 255, 255, 0.6);
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.72);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
		color: var(--color-text);
		font-size: 0.8rem;
		font-weight: 600;
	}

	.searchbar__toggle-icon {
		font-size: 0.7rem;
		line-height: 1;
	}

	/* A small accent dot shown when the row is collapsed but filters are active, so
	   the user knows a search is still in effect behind the folded controls. */
	.searchbar__dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 999px;
		background: var(--color-accent);
	}

	/* A plain search pill (Place / Item): a glassy floating field matching the tag
	   pickers, so every floating control reads as one family. The input grows to fill
	   the pill so the trailing search icon sits flush at the right edge. */
	.searchpill {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		width: 11rem;
		padding: 0.3rem 0.5rem;
		cursor: text;
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.72);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
	}

	.searchpill:focus-within {
		border-color: var(--color-accent);
	}

	.searchpill__input {
		flex: 1;
		min-width: 0;
		padding: 0.15rem 0.25rem;
		font: inherit;
		font-size: 0.9rem;
		color: var(--color-text);
		background: none;
		border: none;
		outline: none;
	}

	.searchpill__input::placeholder {
		color: var(--color-text-muted);
	}

	/* The trailing search glyph. It lives inside the Lucide child's <svg>, so it's
	   reached with a scoped :global descendant rule; currentColor drives its stroke. */
	.searchpill :global(.searchpill__icon) {
		flex-shrink: 0;
		/* Decorative: let clicks fall through to the <label> so it focuses the input. */
		pointer-events: none;
		color: var(--color-text-muted);
	}

	/* Stand-in for the Place pill shown while a location is pinned: a floating
	   accent-tinted card marking it as an active selection rather than an editable
	   field. Carries its own glass shadow since it floats free like the pills. */
	.place-card {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		max-width: 18rem;
		padding: 0.5rem 0.6rem;
		border-radius: 0.7rem;
		background: color-mix(in srgb, var(--color-accent) 12%, rgba(255, 255, 255, 0.85));
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, #fff);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
	}

	.place-card__body {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
		flex: 1;
	}

	.place-card__name {
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--color-text);
	}

	.place-card__meta {
		font-size: 0.78rem;
		color: var(--color-text-muted);
		word-break: break-word;
	}

	.place-card__clear {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.4rem;
		height: 1.4rem;
		padding: 0;
		font-size: 0.85rem;
		line-height: 1;
		color: var(--color-accent);
		background: rgba(255, 255, 255, 0.6);
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, #fff);
		border-radius: 999px;
		transition:
			background-color 0.12s,
			color 0.12s;
	}

	.place-card__clear:hover {
		color: #fff;
		background: var(--color-accent);
	}

	/* Fills remaining panel height; only the list inside it scrolls, so the
	   count label stays pinned without bleeding scrolled cards behind it. */
	.results {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.results__count {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-text-muted);
	}

	/* "· nearest first" qualifier on the count, shown while a global search is active
	   so the list's ordering reads as deliberate. */
	.results__scope {
		font-weight: 500;
		color: var(--color-accent);
	}

	/* Cap notice: shown when the viewport held more places than the server returns
	   in one read (MAX_RESULTS). Accent-tinted so it reads as an actionable hint. */
	.results__note {
		margin: 0;
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-accent);
	}

	.results__empty {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.9rem;
	}

	.results__list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		/* Negative margin lets the scrollbar sit at the panel edge. */
		margin: 0 -0.4rem;
		padding: 0 0.4rem 0.2rem;
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		width: 100%;
		/* Reset the native <button> chrome so the card reads as a list item. */
		appearance: none;
		text-align: left;
		color: inherit;
		padding: 0.7rem 0.8rem;
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.65);
		border: 1px solid rgba(0, 0, 0, 0.06);
		transition:
			background-color 0.12s,
			border-color 0.12s;
	}

	.card:hover {
		background: rgba(255, 255, 255, 0.96);
		border-color: var(--color-accent);
	}

	.card:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}

	.card__name {
		font-weight: 600;
		color: var(--color-text);
		/* Lay the name out as a row so a chain group card's count pill can sit
		   beside it (see .card__count); plain cards have no pill, so this is inert. */
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.card__category {
		font-size: 0.8rem;
		color: var(--color-accent);
	}

	.card__address {
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}

	.card__items {
		list-style: none;
		margin: 0.45rem 0 0;
		padding: 0.45rem 0 0;
		border-top: 1px solid rgba(0, 0, 0, 0.08);
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.card__item {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.8rem;
	}

	/* The name/price row of a matched item; the dietary badges sit on the line below. */
	.card__item-line {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.75rem;
	}

	.card__item-name {
		color: var(--color-text);
	}

	.card__item-price {
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	/* --- Deduped chain group card -------------------------------------------- */
	/* Branch count pill on a chain group card ("KFC · 511 locations"). */
	.card__count {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-accent);
		background-color: color-mix(in srgb, var(--color-accent) 12%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, #fff);
		border-radius: 999px;
		padding: 0.05rem 0.45rem;
		white-space: nowrap;
	}

	/* The show/hide-branches affordance at the foot of a group card. */
	.card__expand {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		margin-top: 0.35rem;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--color-accent);
	}

	.card__expand-icon {
		font-size: 0.7rem;
		line-height: 1;
	}

	/* Branch list revealed when a group card is expanded. Indented and rail-marked
	   so the branches read as children of the group above them. */
	.group__members {
		list-style: none;
		margin: 0.35rem 0 0 0.6rem;
		padding: 0 0 0 0.6rem;
		border-left: 2px solid color-mix(in srgb, var(--color-accent) 25%, transparent);
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.card--member {
		padding: 0.5rem 0.7rem;
	}

	.card__address--empty {
		font-style: italic;
	}

	/* --- Selected-location detail view (replaces the results list) ----------- */
	.detail {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.detail__back {
		align-self: flex-start;
		background: none;
		border: none;
		padding: 0;
		color: var(--color-accent);
		font-size: 0.85rem;
		font-weight: 600;
	}

	.detail__back:hover {
		text-decoration: underline;
	}

	/* Only the body scrolls; the back button stays pinned at the top. */
	.detail__body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		/* Negative margin lets the scrollbar sit at the panel edge. */
		margin: 0 -0.4rem;
		padding: 0 0.4rem 0.2rem;
	}

	/* Like buttons (LikeButton.svelte) overlaid on result cards and menu rows. Each
	   sits absolutely in the top-right of its row as a SIBLING of the row's button —
	   never nested, since a <button> can't contain another button — so a tap likes
	   the row without also activating it. The row reserves right padding for it only
	   when signed in (the `--likeable` modifier), so the signed-out layout is
	   unchanged. */
	.results__list > li,
	.group__members > li {
		position: relative;
	}

	.card--likeable {
		padding-right: 2.1rem;
	}

	.card__like {
		position: absolute;
		top: 0.4rem;
		right: 0.4rem;
		z-index: 1;
	}

	.menu__item--likeable {
		position: relative;
	}

	.menu__item--likeable .menu__trigger {
		padding-right: 1.9rem;
	}

	.menu__like {
		position: absolute;
		top: 0.5rem;
		right: 0;
		z-index: 1;
	}

	.detail__like {
		margin-left: auto;
	}

	.detail__header {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.detail__name {
		margin: 0;
		font-size: 1.15rem;
	}

	.badge {
		display: inline-block;
		padding: 0.15rem 0.55rem;
		border-radius: 999px;
		background-color: var(--color-accent);
		color: #fff;
		font-size: 0.72rem;
		font-weight: 600;
		line-height: 1.4;
		white-space: nowrap;
	}

	.info {
		display: grid;
		gap: 0.4rem;
		margin: 0;
		padding: 0.75rem 0.85rem;
		background: rgba(255, 255, 255, 0.6);
		border: 1px solid var(--color-border);
		border-radius: 0.7rem;
	}

	.info__row {
		display: grid;
		grid-template-columns: 5rem 1fr;
		gap: 0.25rem 0.75rem;
		align-items: baseline;
	}

	.info dt {
		color: var(--color-text-muted);
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.info dd {
		margin: 0;
		font-size: 0.85rem;
		word-break: break-word;
	}

	.info__sources {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.menu {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	/* The "Menu" title and its freshness badge sit on one baseline-aligned row. */
	.menu__head {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0 0 0.25rem;
	}

	.menu__heading {
		margin: 0;
		font-size: 0.95rem;
	}

	/* Menu freshness ("Verified 3 months ago"): a quiet accent pill, turning amber
	   and muted once the menu is past VERIFIED_STALE_DAYS. */
	.menu__verified {
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--color-accent);
		background-color: color-mix(in srgb, var(--color-accent) 10%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 30%, #fff);
		border-radius: 999px;
		padding: 0.05rem 0.45rem;
		white-space: nowrap;
	}

	.menu__verified--stale {
		color: #9a6a00;
		background-color: #fff6e5;
		border-color: #f0d28a;
	}

	.menu__empty {
		margin: 0;
		font-size: 0.85rem;
		font-style: italic;
		color: var(--color-text-muted);
	}

	.menu__filtered {
		margin: 0 0 0.25rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-text-muted);
	}

	.menu__list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.menu__item {
		padding: 0.6rem 0;
		border-bottom: 1px solid rgba(0, 0, 0, 0.08);
	}

	.menu__item:last-child {
		border-bottom: none;
	}

	/* Narrow-screen inline expansion of a tapped item's details (tags, sources),
	   shown in place of the wide-screen floating popup. Collapses to
	   nothing when the item has no extra details to show. */
	.menu__details {
		margin: 0.15rem 0 0.1rem;
	}

	.menu__details:empty {
		display: none;
	}

	/* The whole row is a button: hovering or focusing it reveals the details
	   popup, and a click/tap toggles it (the touch path). Styled to read as the
	   plain text row it replaced. */
	.menu__trigger {
		display: block;
		width: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.menu__trigger:hover .menu__name,
	.menu__trigger:focus-visible .menu__name {
		color: var(--color-accent);
	}

	.menu__trigger:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
		border-radius: 0.4rem;
	}

	.menu__line {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.75rem;
	}

	.menu__name {
		font-weight: 600;
		font-size: 0.9rem;
	}

	.menu__price {
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.menu__description {
		display: block;
		margin: 0.3rem 0 0;
		font-size: 0.82rem;
		color: var(--color-text-muted);
	}

	.menu__description--empty {
		font-style: italic;
	}

	/* The course-tag pill row under an item's details. The pills themselves are
	   <FoodTag>; this only lays them out. */
	.taglist {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin: 0.4rem 0 0;
		padding: 0;
	}

	/* Inline variant: the dietary badges shown directly on a menu/result row (see the
	   dietaryBadges snippet), with a tighter top margin so they hug the row above. */
	.taglist--inline {
		margin-top: 0.3rem;
	}

	/* Provenance for the item. The popup is non-interactive (pointer-events: none),
	   so these are shown as plain labels/hostnames rather than clickable links;
	   the interactive location detail panel renders sources as real links. */
	.sources {
		margin: 0.5rem 0 0;
	}

	.sources__label {
		display: block;
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
	}

	.sources__list {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin: 0.25rem 0 0;
		padding: 0;
	}

	.source {
		max-width: 100%;
		overflow: hidden;
		font-size: 0.72rem;
		color: var(--color-accent);
		background-color: color-mix(in srgb, var(--color-accent) 8%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 25%, #fff);
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	/* The details popup floats over the map, to the left of the hovered/tapped
	   row. The positioning effect sets its `top`/`right`; it's non-interactive so
	   it never steals hover from the row or blocks the map beneath it. A touch
	   higher opacity than the panels keeps text legible over the map. */
	.menu-popup {
		position: fixed;
		z-index: 20;
		width: min(18rem, calc(100vw - 2rem));
		max-height: calc(100dvh - 2rem);
		overflow-y: auto;
		padding: 0.85rem 0.95rem;
		border-radius: 0.85rem;
		background: rgba(255, 255, 255, 0.92);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 10px 34px rgba(0, 0, 0, 0.22);
		pointer-events: none;
	}

	/* Below ~48rem the search row and results can't sit abreast, so let the search
	   row span the top (its items wrapping into their own row) and drop results to a
	   bottom sheet. */
	@media (max-width: 48rem) {
		.searchbar {
			right: calc(1rem + env(safe-area-inset-right));
			max-width: none;
		}

		/* The items become their own full-width wrapping row beneath the brand/toggle
		   line, so the collapse toggle can fold just them away. */
		.searchbar__items {
			display: flex;
			flex-wrap: wrap;
			gap: 0.5rem;
			width: 100%;
		}

		.searchbar__items--collapsed {
			display: none;
		}

		/* The toggle leads its own line; the items wrap into the full-width row below. */
		.searchbar__toggle {
			display: inline-flex;
		}

		.panel--results {
			top: auto;
			bottom: calc(1rem + env(safe-area-inset-bottom));
			left: calc(1rem + env(safe-area-inset-left));
			right: calc(1rem + env(safe-area-inset-right));
			width: auto;
			max-height: 45dvh;
		}

		/* 16px inputs stop iOS Safari from auto-zooming the page when one is focused. */
		.searchpill__input {
			font-size: 1rem;
		}

		.place-card__clear {
			width: 1.9rem;
			height: 1.9rem;
			font-size: 1rem;
		}
	}
</style>
