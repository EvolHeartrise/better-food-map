<script lang="ts">
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { fly } from 'svelte/transition';
	import { SvelteSet, SvelteMap, MediaQuery } from 'svelte/reactivity';
	import {
		getLocations,
		getLocationData,
		searchLocations,
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
	import { categoryLabel } from '$lib/category';
	import { matchedItems, searchResults } from '$lib/search-match';
	import { idFromPath } from '$lib/location-path';
	import { DEFAULT_MAP_CENTER } from '$lib/map-defaults';
	import { searchableQuery } from '$lib/search';
	import type { MapData, MapItem, MapLocation, Item, Bounds } from '$lib/server/db';

	// The visible map area, reported by <LocationMap> (debounced) as the user pans
	// and zooms, plus once on load. This is the ONLY thing that decides which data
	// we fetch — the area filter is now "whatever's on screen". Null until the map
	// has mounted and reported its opening view.
	let viewport = $state<Bounds | null>(null);

	// --- Search filters --------------------------------------------------------
	// One combined free-text box plus the dietary selector. `query` matches a venue by
	// NAME *or* by an item name — a name match surfaces the whole menu, an item-only
	// match surfaces just the matching items (see `matchedItems`). The dietary selector
	// is a separate filter that always narrows the items shown (single-select: an item
	// must carry the chosen tag — vegan, gluten_free, …). With either set the search
	// goes GLOBAL — the whole index, nearest first (see the search effect below) —
	// rather than narrowing only what's on screen; cleared, the map returns to browsing
	// the current viewport.
	let query = $state('');
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
		// A user's explicit pick must win over the saved diet even if getDiet() hasn't
		// resolved yet — arm the seed guard so a late-arriving value can't clobber it.
		dietSeeded = true;
		diet = id;
		if (user) setDiet(id).catch(() => {});
	}

	// The text query, normalised once and shared by the map item labels, the venue
	// membership test and the global-search effect so they all agree on what "matches".
	// `hasQuery` — text query or diet active — is what flips browse → search.
	const queryTerm = $derived(query.trim().toLowerCase());
	const hasQuery = $derived(queryTerm !== '' || diet !== null);
	// The text actually sent to the global search: the trimmed query once (and only
	// once) the server's trigram index can accelerate it — a 3+ character
	// wildcard-free run ($lib/search). Below that floor a server search would full-
	// scan both FTS mirrors for a result the local in-view filtering above already
	// delivers instantly, so short/wildcard-only text stays client-side ('' here)
	// and the server applies the same gate (getSearchMapData). `hasSearchText` is
	// the boolean read by the search effect, so a case-only edit (which can't
	// change the results — matching is case-insensitive) doesn't re-fire it.
	const searchText = $derived(searchableQuery(query));
	const hasSearchText = $derived(searchText !== '');

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
		getLocations(bounds)
			.then((data) => {
				if (!cancelled) viewportData = data;
			})
			// A failed fetch must not blank the map — keep the markers already on
			// screen; the next pan/zoom issues a fresh request anyway.
			.catch((err) => console.error('viewport locations fetch failed', bounds, err));
		return () => {
			cancelled = true;
		};
	});

	// The map centre — the anchor "nearest" is measured from — as its midpoint, with
	// a default (the shared Vancouver fallback, $lib/map-defaults) before the first
	// viewport is reported. Read non-reactively inside the search effect's timer, so
	// panning alone never re-runs a search; only changing the query does.
	const DEFAULT_CENTER = DEFAULT_MAP_CENTER;
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
	// The query, reduced to a stable string — the reactive trigger for the search
	// effect's server call, so the map centre (read inside the timer) can change
	// with a pan without re-running the search. Built from the GATED text
	// (`searchText`, lowercased to match the server's case-insensitive LIKE), so
	// typing through the sub-searchable prefixes of a term ("b", "bu") never fires
	// a request. Each distinct query runs (and flies) once; an unchanged query
	// never re-fires the effect.
	const querySignature = $derived(JSON.stringify({ query: searchText.toLowerCase(), diet }));

	// Search mode: run a global, nearest-first search whenever the QUERY changes. On
	// each query's result, fly to the nearest match unless it's already on screen.
	// Clearing the query drops back to browse mode.
	$effect(() => {
		if (!hasQuery) {
			searchData = null;
			return;
		}
		// Text below the searchable floor with no diet active: there is nothing the
		// server could do but full-scan (see $lib/search), and the in-view filtering
		// already handles the short term instantly — so skip the call and stay on
		// the viewport set (searchData null → activeData falls back).
		if (!hasSearchText && diet === null) {
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
				query: searchText,
				dietTagId: diet,
				lat: center.lat,
				lng: center.lng
			})
				.then((data) => {
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
				})
				// A failed search keeps the previous result set (or the viewport
				// fallback) on screen rather than blanking the map mid-search.
				.catch((err) => console.error('search failed', querySignature, err));
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	// The data the page renders from: the global search set while a query is active
	// (falling back to the viewport set until the first search returns, so the labels
	// filter what's on screen instantly rather than blanking), otherwise the
	// viewport set.
	const activeData = $derived(hasQuery ? (searchData ?? viewportData) : viewportData);

	// The map page works against each location's fully-resolved `menu`, but the wire
	// payload sends each menu only once (keyed by menu_id) instead of copying it onto
	// every branch that serves it. Rebuild the effective menu here: the items of the
	// location's menu (its own private menu, or a shared brand menu) with this
	// location's per-item overrides applied — items marked unavailable dropped,
	// overridden prices used — and attach the menu's `last_verified` freshness date.
	// Generic over the item shape (#83): the viewport/search payloads carry lean
	// MapItems (the map only renders names + tags), while the by-id detail fetch
	// resolves full Items for the open venue's panel.
	function resolveLocation<I extends MapItem>(
		loc: MapLocation,
		data: MapData<I>
	): MapLocation & { menu: I[]; lastVerified: string | null } {
		const menu: I[] = [];
		if (loc.menu_id) {
			const overrideByItem = new Map(loc.overrides.map((o) => [o.item_id, o]));
			for (const menuItem of data.menus[loc.menu_id] ?? []) {
				const override = overrideByItem.get(menuItem.id);
				if (override?.available === false) continue; // not served at this branch
				// Reuse the shared item object unless this branch overrides its price.
				// A price override only applies to the full detail shape — the lean
				// viewport items carry no price to override. The cast is sound: the
				// spread copies I and rewrites `price`, which Item types number|null.
				if (override !== undefined && override.price !== null && 'price' in menuItem) {
					menu.push({ ...menuItem, price: override.price } as I);
				} else {
					menu.push(menuItem);
				}
			}
		}
		const lastVerified = loc.menu_id ? (data.menuMeta[loc.menu_id]?.last_verified ?? null) : null;
		return { ...loc, menu, lastVerified };
	}

	const locations = $derived(activeData.locations.map((loc) => resolveLocation(loc, activeData)));

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
	// the app UI (search) takes over. "Start using" flies past this threshold, and
	// zooming the globe in/out crosses it to leave/return to the landing.
	const LANDING_MAX_ZOOM = 3;

	// The live map zoom, reported by <LocationMap>. Null until the map first reports it;
	// treated as zoomed-out until then (the map opens at WORLD_ZOOM).
	let zoomLevel = $state<number | null>(null);

	// Coverage totals for the overlay, read non-suspending (`.current`) so the map
	// paints immediately and the figures fill in when the count query resolves.
	const statsResource = getStats();
	const stats = $derived(statsResource.current ?? null);

	// Hydration fallback: when the SSR render raced the stats read and serialized
	// no result, the client-side query instance has been observed to stay pending
	// forever rather than issuing its own fetch (experimental remoteFunctions), so
	// the overlay would sit on its placeholders. One explicit refresh() fills it.
	// The effect re-runs only when `current` changes, so a persistent failure
	// can't loop it, and once a value lands it never fires again.
	$effect(() => {
		if (statsResource.current === undefined) {
			void statsResource.refresh().catch(() => {});
		}
	});

	// The visitor's IP-detected location, resolved with a TOP-LEVEL AWAIT so it is
	// genuinely part of the render: awaited during SSR it settles immediately (the
	// lookup reads `request.cf` with no I/O) and the value serializes into the page,
	// so the client hydrates with it and a "Start using" click needs no network at
	// all. Merely CREATING the query instance is not enough — an instance nothing
	// awaits or renders is neither fetched at hydration nor serialized (the same
	// lesson as the stats fallback above), which is why this mirrors the awaited
	// `user`/`landingData` pattern rather than holding an idle handle. The catch
	// folds a failed lookup into the documented null return, so a network error at
	// hydration can't take down the page render.
	const userLocation = $derived(await getUserLocation().catch(() => null));

	// "Start using the map": fly to the visitor's IP-detected location at city zoom, which
	// leaves the landing (the zoom passes LANDING_MAX_ZOOM). getUserLocation is prompt-free
	// edge geolocation — null under local dev or when unavailable, so we fall back to the
	// default centre. The fly reuses the search focus channel (a fresh nonce flies exactly
	// once); with no `zoom` override it pulls in to a city view.
	function startUsing(): void {
		const target = userLocation ?? { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };
		focusNonce += 1;
		focusTarget = { latitude: target.lat, longitude: target.lng, key: String(focusNonce) };
	}

	// A location with its FULL effective menu resolved (see resolveLocation), plus
	// its menu's `last_verified` freshness date (null for unverified/private
	// menus). This is the detail-panel shape — only the by-id fetch carries full
	// Items; the in-view set resolves to lean MapItems (#83).
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

	// One entry per location to show, paired with the items to tease under its marker.
	// The candidate set is whatever is currently visible on the map (`locations`). The
	// membership rule — venue-name OR item-name substring, diet always narrowing on the
	// same item, everything kept in browse mode — lives in $lib/search-match, a pure
	// module mirroring the server's getSearchMapData so scripts/search-parity.test.ts
	// can hold the two halves to identical membership.
	const results = $derived(searchResults(locations, queryTerm, diet));

	// --- Accessible results list -------------------------------------------------
	// The map pills are aria-hidden and pointer-transparent (selection happens via
	// the map canvas hit-test), so keyboard and assistive-tech users need a real
	// DOM path to open a venue. `results` is re-rendered as a visually hidden list
	// of genuine <button>s that call selectLocation; while focus is inside it the
	// list expands into a visible panel, so sighted keyboard users aren't stepping
	// through invisible controls. The map plots every match — the rendered list is
	// capped so a country-wide chain search doesn't drop thousands of nodes in.
	const RESULTS_LIST_MAX = 50;
	const listedResults = $derived(results.slice(0, RESULTS_LIST_MAX));

	// The count announced by the aria-live region. Only speaks once a SEARCH has
	// settled (searchData stays null while browsing and until the first result set
	// for a query returns), so pans and the pre-debounce fallback stay silent.
	const resultsAnnouncement = $derived(
		hasQuery && searchData !== null
			? `${results.length} ${results.length === 1 ? 'place' : 'places'} found`
			: ''
	);

	// Selecting from the results list hides the searchbar (the detail panel owns
	// the page then), which would drop keyboard focus on <body> — so move it onto
	// the panel's first control (its close button) once the panel has rendered.
	let placecardEl = $state<HTMLElement | null>(null);
	async function selectFromList(id: string): Promise<void> {
		selectLocation(id);
		await tick();
		placecardEl?.querySelector('button')?.focus();
	}

	// The map plots EVERY matching location — the map itself is the result surface.
	// Each carries the item names its label rotates through; a 30-branch chain
	// still drops 30 name pills.
	const mapLocations = $derived(
		results.map((result) => ({
			id: result.loc.id,
			name: result.loc.name,
			latitude: result.loc.latitude,
			longitude: result.loc.longitude,
			items: result.items.map((menuItem) => menuItem.item_name)
		}))
	);

	// --- Selected location (integrated detail view) ---------------------------
	// The open location is driven by shallow routing: selecting pushes a
	// `/locations/<id>` history entry (without navigating) that carries the id
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
	// The plain const holds the hard-load snapshot itself (it never changes for the
	// life of the page); the $state wrapping it exists so `closeDetail` can null it.
	const initialLandingId = idFromPath(page.url.pathname);
	let landingId = $state(initialLandingId);
	const selectedId = $derived(page.state.selected ?? landingId);

	// --- SSR head data for /locations/<id> links -------------------------------
	// A hard load of a `/locations/<id>` link must ship the VENUE's metadata in the
	// server-rendered head: crawlers and link unfurlers read only that HTML, and the
	// client-only $effect that resolves `selectedLocation` (below) never runs during
	// SSR. So when the page lands on a venue URL, fetch it here with a top-level
	// await — the query runs on the server and its result is serialized into the
	// page for hydration. The detail $effect asks for the same id again on the
	// client, but getLocationData dedupes by argument, so this never costs a second
	// request. An unknown id yields an empty payload (no venue), and a failed fetch
	// falls back the same way — the page must still render with the default head
	// rather than break over metadata.
	const landingData =
		initialLandingId === null ? null : await getLocationData(initialLandingId).catch(() => null);
	const landingLoc = landingData?.locations[0] ?? null;
	const landingVenue: LocationData | null =
		landingData && landingLoc ? resolveLocation(landingLoc, landingData) : null;

	// True while the landing should show (see the WORLD_ZOOM block): the map is zoomed out
	// onto the globe with nothing open. An open location (including a `/locations/<id>`
	// deep link, via `selectedId`) always takes precedence, and zooming back out brings the
	// landing back. While it's up, the search controls are hidden so the globe and the two
	// floating landing pieces are all that show.
	const landing = $derived(!selectedId && (zoomLevel === null || zoomLevel <= LANDING_MAX_ZOOM));

	// The resolved record for the open location, always fetched by id: the
	// viewport/search payloads carry only the lean item shape (no description/
	// price/sources — see #83), so the in-view record can't feed the detail panel.
	// getLocationData dedupes by id, so only the FIRST open of a venue costs a
	// round trip; re-opening it (and the landing venue, awaited above) is instant.
	// Held in state (not a derived) and updated imperatively so the open detail
	// stays put while a by-id fetch is in flight — panning the place off screen
	// doesn't flash the panel closed. Seeded from the awaited landing venue so a
	// hard `/locations/<id>` load server-renders the panel body too, not just the
	// head. Deliberately NOT nulled on deselect: everything that shows it gates on
	// `selectedId`, and keeping the last venue gives the closing panel's slide-out
	// its content (an emptied panel would blank mid-animation).
	let selectedLocation = $state<LocationData | null>(landingVenue);
	$effect(() => {
		const id = selectedId;
		if (!id) return;
		// We leave any currently-shown detail in place until this resolves.
		let cancelled = false;
		getLocationData(id)
			.then((data) => {
				if (cancelled) return;
				const loc = data.locations[0];
				selectedLocation = loc ? resolveLocation(loc, data) : null;
			})
			// On failure keep whatever detail is showing — closing the card over a
			// transient error would be worse than briefly stale info.
			.catch((err) => console.error('location detail fetch failed', id, err));
		return () => {
			cancelled = true;
		};
	});

	// The venue driving the head metadata. Gated on `selectedId` because
	// `selectedLocation` intentionally survives a close (see above): once the
	// detail is closed this drops to null and the head reverts to the static
	// defaults.
	const headVenue = $derived(selectedId ? (selectedLocation ?? landingVenue) : null);

	// The canonical public origin for og:url — a shared /locations/<id> link should
	// unfurl against the production URL regardless of which host served the page.
	const CANONICAL_ORIGIN = 'https://betterfoodmaps.com';

	// Title, description and canonical URL for the venue head. The description
	// leads with the category label and address, plus the menu size when there is
	// one; null keeps the static site-wide head.
	const headMeta = $derived.by(() => {
		if (!headVenue) return null;
		const count = headVenue.menu.length;
		const parts = [
			categoryLabel(headVenue.category),
			headVenue.address,
			count > 0 ? `${count} menu item${count === 1 ? '' : 's'}` : ''
		].filter(Boolean);
		return {
			title: `${headVenue.name} — BetterFoodMaps`,
			description: `${headVenue.name} on BetterFoodMaps${parts.length > 0 ? ` — ${parts.join(' · ')}` : ''}.`,
			url: `${CANONICAL_ORIGIN}/locations/${encodeURIComponent(headVenue.id)}`
		};
	});

	// The selected venue, trimmed to what <LocationMap> needs and carrying its own
	// rotating item line. Passed as `selected` so the map keeps its label (and rotation)
	// even when the venue isn't among `mapLocations` — opened from a `/locations/<id>`
	// link, or panned off screen. Gated on `selectedId` (not just the resolved record,
	// which survives a close — see selectedLocation) so deselecting unhighlights.
	const mapSelected = $derived(
		selectedId && selectedLocation
			? {
					id: selectedLocation.id,
					name: selectedLocation.name,
					latitude: selectedLocation.latitude,
					longitude: selectedLocation.longitude,
					items: matchedItems(selectedLocation, queryTerm, diet).map(
						(menuItem) => menuItem.item_name
					)
				}
			: null
	);

	// --- Detail panel geometry ---------------------------------------------------
	// While a location is open, its details live in a panel docked to an edge: a
	// fixed-width column on the RIGHT on wide screens, a bottom sheet on narrow ones
	// (the 48rem breakpoint the rest of the page uses). The same footprint is passed
	// to <LocationMap> as a camera inset so the venue centres in the map area the
	// panel leaves visible. These px values mirror the CSS (26rem / 320px); the map
	// clamps them against its own size, so the CSS caps (100vw, 55dvh) need no echo.
	const PANEL_WIDTH_PX = 416;
	const SHEET_HEIGHT_PX = 320;
	const narrowScreen = new MediaQuery('(max-width: 48rem)');
	const detailInset = $derived(
		selectedId
			? narrowScreen.current
				? { right: 0, bottom: SHEET_HEIGHT_PX }
				: { right: PANEL_WIDTH_PX, bottom: 0 }
			: null
	);

	// How the panel enters/leaves: sliding from the edge it docks to. `opacity: 1`
	// keeps it fully opaque throughout — the motion alone is the transition.
	const panelFly = $derived(
		narrowScreen.current
			? { y: '100%', duration: 300, opacity: 1 }
			: { x: '100%', duration: 300, opacity: 1 }
	);

	function selectLocation(id: string): void {
		// Selecting a place (e.g. tapping a name pill on the map) sets `selectedId`,
		// which leaves the landing (see `landing`) so the detail card can show.
		// `/locations/<id>` is a synthetic shallow-routing URL: there is no such route
		// (the `reroute` hook serves this root map page for it), so the address bar can
		// reflect the open location — and the link stays shareable — without a real
		// navigation. Because it isn't a real route it can't go through the typed
		// `resolve(routeId)`, hence the lint exception on the calls below.
		const url = `/locations/${encodeURIComponent(id)}`;
		const state = { selected: id };
		// Reuse the current history entry when switching between locations, so Back
		// always returns to the prior view rather than the previously viewed place.
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
		// being a selection-free view and on an async `popstate` to reset
		// `page.state`. Neither holds when the page was opened on a `/locations/<id>`
		// link, so Back there could leave the detail open. Pressing the browser Back
		// button still closes the detail via the prior `/` entry, so back/forward
		// stays intuitive.
		replaceState(resolve('/'), {});
	}

	// A click on bare map (reported by <LocationMap>) closes the open detail. Guarded
	// so ordinary map clicks with nothing open don't rewrite the history entry.
	function deselectLocation(): void {
		if (selectedId) closeDetail();
	}

	// --- Account & likes -------------------------------------------------------
	// The signed-in user (null when signed out) drives the account control and gates
	// the like buttons. getLikes() itself returns empty lists when signed out, so it
	// needn't wait on the user read.
	const user = $derived(await getCurrentUser());
	const serverLikes = $derived(await getLikes());

	// Optimistic like state: a pending map of just-toggled ids layered over the
	// server set, so a tap reflects instantly without waiting on the round trip (and
	// reverts if it fails). The pending maps are reactive, so the id sets below
	// recompute as toggles land; a later server reload supersedes the pending entry.
	const pendingLocationLikes = new SvelteMap<string, boolean>();

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

	function toggleLocationLike(id: string) {
		const liked = likedLocationIds.has(id);
		pendingLocationLikes.set(id, !liked);
		setLocationLiked({ locationId: id, liked: !liked }).catch(() =>
			pendingLocationLikes.set(id, liked)
		);
	}

	// Item likes mirror location likes exactly — same pending overlay over the
	// server set, same optimistic set-then-revert — keyed by item id and backing
	// the heart on each menu row in the open venue's card.
	const pendingItemLikes = new SvelteMap<string, boolean>();

	const likedItemIds = $derived(overlayLikes(serverLikes.itemIds, pendingItemLikes));

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
	//
	// The stored value is a plain calendar day, not an instant, so we compare
	// calendar dates in the user's LOCAL timezone. `new Date('YYYY-MM-DD')` would
	// parse as UTC midnight, and diffing that against Date.now() makes a menu
	// verified today read "Verified yesterday" for part of the day anywhere west
	// of UTC (at 5pm PDT the clock is already ≥24h past UTC midnight). So we pull
	// the y/m/d out ourselves, build both sides as local midnights, and Math.round
	// the difference to absorb the ±1h a DST boundary injects.
	const VERIFIED_STALE_DAYS = 180;
	function verifiedDaysAgo(iso: string): number | null {
		const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
		if (!match) return null;
		const then = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		return Math.round((today.getTime() - then.getTime()) / 86_400_000);
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
</script>

<svelte:head>
	{#if headMeta}
		<!-- Venue head for an open location. On a hard /locations/<id> load this is
		     already in the server-rendered HTML (see the landing-venue fetch above),
		     so link unfurlers and crawlers see the venue rather than the site
		     defaults. Svelte escapes text and attribute content here, so the venue
		     fields need no hand-escaping. -->
		<title>{headMeta.title}</title>
		<meta name="description" content={headMeta.description} />
		<meta property="og:title" content={headMeta.title} />
		<meta property="og:description" content={headMeta.description} />
		<meta property="og:site_name" content="BetterFoodMaps" />
		<meta property="og:type" content="website" />
		<meta property="og:url" content={headMeta.url} />
	{:else}
		<title>BetterFoodMaps</title>
		<meta
			name="description"
			content="Explore cafes, fast food and restaurants around the world on an interactive map."
		/>
	{/if}
</svelte:head>

<div class="app" class:app--detail={Boolean(selectedId)}>
	<div class="app__map">
		<LocationMap
			locations={mapLocations}
			selected={mapSelected}
			onselect={selectLocation}
			ondeselect={deselectLocation}
			{detailInset}
			initialCenter={WORLD_CENTER}
			initialZoom={WORLD_ZOOM}
			onzoom={(z) => (zoomLevel = z)}
			focus={focusTarget}
			onviewchange={(bounds) => (viewport = bounds)}
		/>
	</div>

	<!-- The open location's page details: a panel docked to the right edge (a bottom
	     sheet on narrow screens) beside the map, which keeps the venue centred in the
	     space the panel leaves it (see detailInset). Slides in on select and away on
	     close/deselect. Gated on `selectedId` so closing starts the slide-out at once;
	     the content reads the retained `selectedLocation`, which stays valid through
	     the outro. -->
	{#if selectedId && selectedLocation}
		{@const loc = selectedLocation}
		{@const label = categoryLabel(loc.category)}
		<aside
			class="placecard"
			aria-label="Location details"
			bind:this={placecardEl}
			transition:fly={panelFly}
		>
			<button
				type="button"
				class="placecard__close"
				aria-label="Close place details"
				onclick={closeDetail}
			>
				✕
			</button>
			<header class="placecard__head">
				<h2 class="placecard__name">{loc.name}</h2>
				{#if label}
					<span class="badge">{label}</span>
				{/if}
				{#if user}
					<span class="placecard__like">
						<LikeButton
							liked={likedLocationIds.has(loc.id)}
							onToggle={() => toggleLocationLike(loc.id)}
							label={likedLocationIds.has(loc.id) ? 'Unlike this place' : 'Like this place'}
							size={18}
						/>
					</span>
				{/if}
			</header>

			<!-- Everything between the header and the footer scrolls as one column, so a
			     long menu (or a tall info block on the bottom sheet) never overflows the
			     panel. -->
			<div class="placecard__body">
				{#if loc.address || loc.phone || loc.website || loc.sources.length > 0}
					<dl class="info">
						{#if loc.address}
							<div class="info__row">
								<dt>Address</dt>
								<dd>{loc.address}</dd>
							</div>
						{/if}
						{#if loc.phone}
							<div class="info__row">
								<dt>Phone</dt>
								<dd><a href="tel:{loc.phone}">{loc.phone}</a></dd>
							</div>
						{/if}
						{#if loc.website}
							<div class="info__row">
								<dt>Website</dt>
								<dd>
									<a href={loc.website} target="_blank" rel="external noopener noreferrer">
										{loc.website}
									</a>
								</dd>
							</div>
						{/if}
						{#if loc.sources.length > 0}
							<div class="info__row">
								<dt>Sources</dt>
								<dd>
									<ul class="info__sources">
										{#each loc.sources as source (source.url)}
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

				<!-- The venue's full menu. The map labels only rotate a teaser item per
				     venue, so this is where the whole menu — each item's price, description,
				     dietary markers, course and sources — is read. -->
				{#if loc.menu.length > 0}
					<ul class="placecard__menu">
						{#each loc.menu as menuItem (menuItem.id)}
							<li class="placecard__item">
								<span class="placecard__item-line">
									<span class="placecard__item-name">{menuItem.item_name}</span>
									{#if user}
										<span class="placecard__item-like">
											<LikeButton
												liked={likedItemIds.has(menuItem.id)}
												onToggle={() => toggleItemLike(menuItem.id)}
												label={likedItemIds.has(menuItem.id)
													? 'Unlike this item'
													: 'Like this item'}
												size={14}
											/>
										</span>
									{/if}
									<span class="placecard__item-price">
										{formatPrice(menuItem.price, menuItem.currency)}
									</span>
								</span>
								{#if menuItem.description}
									<p class="placecard__item-desc">{menuItem.description}</p>
								{/if}
								{@render dietaryBadges(menuItem)}
								{@render itemExtras(menuItem)}
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<footer class="placecard__foot">
				{#if loc.lastVerified}
					<span
						class="menu__verified"
						class:menu__verified--stale={verifiedIsStale(loc.lastVerified)}
						title={`Menu last verified on ${loc.lastVerified}`}
					>
						{formatVerified(loc.lastVerified)}
					</span>
				{/if}
				{#if loc.menu.length === 0}
					<span class="placecard__hint">No menu on file yet.</span>
				{:else}
					<span class="placecard__hint">
						{loc.menu.length}
						{loc.menu.length === 1 ? 'item' : 'items'}
					</span>
				{/if}
			</footer>
		</aside>
	{/if}

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

		<!-- Search and filter controls are hidden while the landing overlay is up (the
		     globe is just a backdrop then) AND while a location is open (its detail
		     panel owns the page then); only the account control stays. They return the
		     moment the visitor leaves the landing state or closes the location. -->
		{#if !landing && !selectedId}
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
				<!-- The combined search: one pill matching a venue by name OR by an item
			     name. A label so a click anywhere in the pill (the search icon included)
			     focuses the input; the input is the only control inside it. -->
				<label class="searchpill searchpill--search">
					<input
						class="searchpill__input"
						type="search"
						placeholder="Search places & dishes…"
						aria-label="Search by place or dish name"
						bind:value={query}
					/>
					<Search class="searchpill__icon" size={16} aria-hidden="true" />
				</label>

				<!-- The dietary selector: single-select. Filters items to the chosen diet,
			     and persists the choice for the signed-in user (see selectDiet). -->
				<DietSelector value={diet} onSelect={selectDiet} />
			</div>

			<!-- The keyboard/screen-reader path to the venues (the map pills are
			     aria-hidden and pointer-transparent): the same `results` the map plots,
			     as real buttons. Visually hidden until focus enters it, then a compact
			     panel below the search row (see .results). Capped — see listedResults. -->
			{#if listedResults.length > 0}
				<nav class="results" aria-label="Matching places">
					<ul class="results__list">
						{#each listedResults as result (result.loc.id)}
							<li>
								<button
									type="button"
									class="results__item"
									onclick={() => selectFromList(result.loc.id)}
								>
									<span class="results__name">{result.loc.name}</span>
									{#if result.loc.address}
										<span class="results__address">{result.loc.address}</span>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
					{#if results.length > listedResults.length}
						<p class="results__cap">
							Showing the first {RESULTS_LIST_MAX} of {results.length} places. Refine the search to narrow
							the list.
						</p>
					{/if}
				</nav>
			{/if}
		{/if}
	</div>

	<!-- Announces how many places a search matched, once each search settles.
	     Always in the DOM (an aria-live region added on the fly isn't reliably
	     picked up); empty while browsing, so pans announce nothing. -->
	<div class="visually-hidden" role="status">{resultsAnnouncement}</div>

	<!-- An item's DIETARY tags (vegan, gluten-free, halal, …) only, rendered inline on
	     each menu row in the open venue's card so the diet markers are visible at a
	     glance. Course tags stay in itemExtras.
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

	<!-- The item's course tag and its data sources, shown beneath each menu row in the
	     open venue's card. Dietary tags are shown inline on the row above (see
	     dietaryBadges), so they're omitted here to avoid repeating them. An `optional`
	     tag keeps its dashed marker. -->
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
</div>

<style>
	.app {
		position: fixed;
		inset: 0;
		overflow: hidden;
	}

	/* The map fills the whole viewport. A z-index here establishes a stacking
	   context so the floating controls (z-index 10) sit above every MapLibre pane. */
	.app__map {
		position: absolute;
		inset: 0;
		z-index: 0;
	}

	/* While the detail panel is open it covers the map's bottom-right corner, where
	   MapLibre puts the OSM attribution — which must stay visible (OSM tile policy).
	   Shift that control clear of the panel's footprint (the panel's own width
	   expression), transitioned to track the panel's slide. */
	.app--detail .app__map :global(.maplibregl-ctrl-bottom-right) {
		margin-right: calc(min(26rem, 100vw) + env(safe-area-inset-right));
		transition: margin 0.3s ease;
	}

	/* The search controls, free-floating over the map: a horizontal, wrapping row of
	   independent pills (account, Place, Item, Diet) anchored top-left. No shared
	   surface — each child carries its own glass. */
	.searchbar {
		position: absolute;
		z-index: 10;
		top: calc(1rem + env(safe-area-inset-top));
		left: calc(1rem + env(safe-area-inset-left));
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.5rem;
		/* Leave room on the right so the row doesn't run the full width of the map. */
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

	/* A plain search pill: a glassy floating field matching the tag pickers, so every
	   floating control reads as one family. The input grows to fill the pill so the
	   trailing search icon sits flush at the right edge. */
	.searchpill {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		width: 11rem;
		height: var(--control-height);
		padding: 0.3rem 0.5rem;
		cursor: text;
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.72);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
	}

	/* The combined place+dish search now stands in for two old pills, so give it a touch
	   more room for the longer placeholder. */
	.searchpill--search {
		width: 15rem;
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

	/* Standard screen-reader-only box: present in the accessibility tree and the
	   tab order, invisible on screen. Used by the live search-count region. */
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/* --- Accessible results list ----------------------------------------------- */
	/* Visually hidden by default — the map pills are the visual result surface —
	   but real, focusable DOM. The moment focus lands inside (a keyboard user
	   tabbing past the search field), it expands into a glass panel on its own
	   row of the searchbar so the focused venue is visible. */
	.results {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.results:focus-within {
		position: static;
		width: 100%;
		height: auto;
		clip-path: none;
		white-space: normal;
		max-height: min(20rem, 45dvh);
		overflow-y: auto;
		padding: 0.35rem;
		border: 1px solid rgba(255, 255, 255, 0.6);
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.9);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
	}

	.results__list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.results__item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		width: 100%;
		padding: 0.4rem 0.5rem;
		font: inherit;
		text-align: left;
		color: var(--color-text);
		background: none;
		border: none;
		border-radius: 0.5rem;
		cursor: pointer;
	}

	.results__item:hover,
	.results__item:focus-visible {
		background: rgba(0, 0, 0, 0.06);
	}

	.results__name {
		font-size: 0.85rem;
		font-weight: 600;
	}

	.results__address {
		font-size: 0.72rem;
		color: var(--color-text-muted);
	}

	.results__cap {
		margin: 0.25rem 0.5rem 0.15rem;
		font-size: 0.72rem;
		color: var(--color-text-muted);
	}

	/* --- Location detail panel (docked to the right of the map) --------------- */
	/* The open location's page details: a full-height glass column pinned to the
	   right edge, over the map (which insets its camera by the same width, so the
	   venue centres in the visible area to its left). Slides in/out via the fly
	   transition on the element. The 26rem width is mirrored by PANEL_WIDTH_PX. */
	.placecard {
		position: absolute;
		z-index: 12;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(26rem, 100vw);
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: calc(0.85rem + env(safe-area-inset-top)) calc(0.95rem + env(safe-area-inset-right))
			calc(0.85rem + env(safe-area-inset-bottom)) 0.95rem;
		background: rgba(255, 255, 255, 0.94);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border-left: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: -12px 0 34px rgba(0, 0, 0, 0.22);
	}

	/* The scrolling middle of the panel (info block + menu), between the fixed
	   header and footer. min-height: 0 lets it actually shrink inside the flex
	   column so overflow-y can take over. */
	.placecard__body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.placecard__close {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		padding: 0;
		font-size: 0.8rem;
		line-height: 1;
		color: var(--color-text-muted);
		background: rgba(0, 0, 0, 0.04);
		border: 1px solid rgba(0, 0, 0, 0.08);
		border-radius: 999px;
		transition:
			background-color 0.12s,
			color 0.12s;
	}

	.placecard__close:hover {
		color: var(--color-text);
		background: rgba(0, 0, 0, 0.09);
	}

	.placecard__head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		/* Clear the absolutely-positioned close button. */
		padding-right: 1.8rem;
	}

	.placecard__name {
		margin: 0;
		font-size: 1.1rem;
	}

	.placecard__like {
		display: inline-flex;
	}

	.placecard__foot {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.placecard__hint {
		font-size: 0.78rem;
		color: var(--color-text-muted);
	}

	/* The open venue's full menu, listed inside the panel body (which owns the
	   scrolling — see .placecard__body). */
	.placecard__menu {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.placecard__item {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		border-top: 1px solid rgba(0, 0, 0, 0.06);
		padding: 0.5rem 0.1rem;
	}

	.placecard__menu li:first-child {
		border-top: none;
	}

	.placecard__item-line {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.75rem;
	}

	.placecard__item-name {
		font-size: 0.85rem;
		font-weight: 600;
		/* Soak up the spare width so the like heart (when signed in) and the price
		   sit together at the row's right edge. */
		flex: 1;
	}

	/* The per-item like heart on a menu row. Centred on the row's height (the line
	   aligns on baselines, which a button doesn't share) so the row stays one line. */
	.placecard__item-like {
		display: inline-flex;
		align-self: center;
	}

	.placecard__item-price {
		font-size: 0.82rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		color: var(--color-text-muted);
	}

	.placecard__item-desc {
		margin: 0;
		font-size: 0.78rem;
		color: var(--color-text-muted);
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

	/* The course-tag pill row under a menu item in the card. The pills themselves are
	   <FoodTag>; this only lays them out. */
	.taglist {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin: 0.4rem 0 0;
		padding: 0;
	}

	/* Inline variant: the dietary badges shown directly on the menu row, with a tighter
	   top margin so they hug the row above. */
	.taglist--inline {
		margin-top: 0.3rem;
	}

	/* Per-item provenance under a menu row, shown as plain labels/hostnames (the venue's
	   own sources in the info block above render as real links). */
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

	/* Below ~48rem let the search row span the top (its items wrapping into their own
	   row, foldable by the toggle); the map card already adapts via its own width clamp. */
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

		/* 16px inputs stop iOS Safari from auto-zooming the page when one is focused. */
		.searchpill__input {
			font-size: 1rem;
		}

		/* On narrow screens the detail panel becomes a bottom sheet: the map keeps the
		   top of the screen (and centres the venue there via the matching bottom
		   camera inset), the details slide up from below. Height mirrors
		   SHEET_HEIGHT_PX, capped so a short landscape screen keeps some map. */
		.placecard {
			top: auto;
			left: 0;
			right: 0;
			width: auto;
			height: min(calc(320px + env(safe-area-inset-bottom)), 55dvh);
			padding: 0.85rem 0.95rem calc(0.85rem + env(safe-area-inset-bottom));
			border-left: none;
			border-top: 1px solid rgba(255, 255, 255, 0.6);
			border-radius: 0.9rem 0.9rem 0 0;
			box-shadow: 0 -12px 34px rgba(0, 0, 0, 0.22);
		}

		/* The sheet covers the map's bottom edge, so both bottom controls — zoom
		   (left) and the OSM attribution (right, which must stay visible) — ride up
		   above it; the right one no longer needs the wide-screen sideways shift. */
		.app--detail .app__map :global(.maplibregl-ctrl-bottom-left),
		.app--detail .app__map :global(.maplibregl-ctrl-bottom-right) {
			margin-bottom: min(calc(320px + env(safe-area-inset-bottom)), 55dvh);
			transition: margin 0.3s ease;
		}

		.app--detail .app__map :global(.maplibregl-ctrl-bottom-right) {
			margin-right: env(safe-area-inset-right);
		}
	}
</style>
