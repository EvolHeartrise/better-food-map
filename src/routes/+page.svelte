<script lang="ts">
	import { resolve } from '$app/paths';
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { SvelteSet, SvelteMap, MediaQuery } from 'svelte/reactivity';
	import { getMapCells, getLocationData, getStats, getUserLocation } from '$lib/data.remote';
	import { ViewportData } from '$lib/viewport-data.svelte';
	import { getCurrentUser, getLikes, setLocationLiked, setItemLiked } from '$lib/user.remote';
	import { createLikeQueue } from '$lib/like-queue';
	import { getDiet, setDiet } from '$lib/profile.remote';
	import LocationMap from '$lib/components/LocationMap.svelte';
	import MapStatsOverlay from '$lib/components/MapStatsOverlay.svelte';
	import DietSelector from '$lib/components/DietSelector.svelte';
	import AccountMenu from '$lib/components/AccountMenu.svelte';
	import VenueDetail from '$lib/components/VenueDetail.svelte';
	import Search from '@lucide/svelte/icons/search';
	import { venueHeadMeta } from '$lib/venue-head';
	import { venueJsonLdScript } from '$lib/venue-jsonld';
	import { matchedItems, searchResults } from '$lib/search-match';
	import { idFromPath, locationPath } from '$lib/location-path';
	import { CANONICAL_ORIGIN } from '$lib/canonical';
	import { DEFAULT_MAP_CENTER } from '$lib/map-defaults';
	import { foldAsciiCase, searchableQuery } from '$lib/search';
	import { resolveLocation, type ResolvedLocation } from '$lib/resolve-location';
	import { m } from '$lib/paraglide/messages';
	import type { Item, Bounds } from '$lib/server/db';
	import type { Map as MapLibreMap } from 'maplibre-gl';

	// The visible map area, reported by <LocationMap> (debounced) as the user pans
	// and zooms, plus once on load. Together with the applied search filter this
	// decides which data we fetch — the area is always "whatever's on screen".
	// Null until the map has mounted and reported its opening view.
	let viewport = $state<Bounds | null>(null);

	// --- Search filters --------------------------------------------------------
	// One combined free-text box plus the dietary selector. `query` matches a venue by
	// NAME *or* by an item name — a name match surfaces the whole menu, an item-only
	// match surfaces just the matching items (see `matchedItems`). The dietary selector
	// is a separate filter that always narrows the items shown (single-select: an item
	// must carry the chosen tag — vegan, gluten_free, …). With either set, the SAME
	// per-cell viewport fetch below narrows server-side to matching venues, so the
	// search follows the map: panning searches the newly visible cells, and what
	// renders is always "the matches in (and just around) the current view".
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

	// Hydration fallback, mirroring the stats one below: this query instance is
	// only ever read via `.current` (never awaited or rendered), so no result is
	// serialized during SSR — and a client-side instance with no serialized result
	// has been observed to stay pending forever rather than issuing its own fetch
	// (experimental remoteFunctions). Without this, `current` would sit undefined
	// and a signed-in user's saved diet would silently never seed the selector.
	// One explicit refresh() fills it. The effect re-runs only when `current`
	// changes, so a persistent failure can't loop it, and once a value lands it
	// never fires again. The seed effect above still applies the value only once
	// (dietSeeded), so a user's explicit pick is never clobbered.
	$effect(() => {
		if (savedDietResource.current === undefined) {
			void savedDietResource.refresh().catch(() => {});
		}
	});

	// Applies a diet selection and persists it for the signed-in user. Called only on
	// a user action (not the initial seed), so it never echoes the loaded value back.
	// For an anonymous visitor the choice is session-local — the selector still applies
	// it, but there's no profile to save it to, so the persist call is skipped.
	function selectDiet(id: string | null): void {
		// A user's explicit pick must win over the saved diet even if getDiet() hasn't
		// resolved yet — arm the seed guard so a late-arriving value can't clobber it.
		dietSeeded = true;
		// One deliberate click, not a keystroke burst: let the search fire at once
		// (see the debounce-bypass note above SEARCH_DEBOUNCE_MS in
		// $lib/viewport-data.svelte.ts).
		viewportStore.searchImmediate = true;
		diet = id;
		if (user) setDiet(id).catch(() => {});
	}

	// The text query, normalised once and shared by the map item labels, the venue
	// membership test and the applied-filter commit so they all agree on what
	// "matches". ASCII-only folding (foldAsciiCase, $lib/search) — the exact case
	// folding the server's LIKE applies — so the local narrowing can never keep a
	// venue the filtered cell read drops.
	const queryTerm = $derived(foldAsciiCase(query.trim()));
	// The text actually sent with the cell fetch: the trimmed query once (and only
	// once) the server's trigram index can accelerate it — a 3+ character
	// wildcard-free run ($lib/search). Below that floor a server-side filter would
	// full-scan both FTS mirrors for a result the local in-view filtering above
	// already delivers instantly, so short/wildcard-only text stays client-side
	// ('' here) and the server applies the same gate (getMapCells).
	const searchText = $derived(searchableQuery(query));

	// --- Viewport data (the cell-fetch orchestration) ---------------------------
	// The client cell store, in-flight bookkeeping, debounced filter commit and
	// searching/fetchFailed status flags all live in $lib/viewport-data.svelte.ts
	// (unit-tested in scripts/viewport-data.test.ts); the page consumes its
	// reactive surface (`data`, `searching`, `fetchFailed`, `appliedFilter`) and
	// drives it with the two thin effects below.
	const viewportStore = new ViewportData(getMapCells);
	const fetchStatus = $derived(
		viewportStore.fetchFailed === 'search'
			? m.search_failed()
			: viewportStore.fetchFailed === 'browse'
				? m.browse_failed()
				: ''
	);

	// The query, reduced to a stable string — the reactive trigger for the commit
	// effect. Built from the GATED text (`searchText`), ASCII-folded EXACTLY like
	// the server's LIKE folds (foldAsciiCase — Unicode lowercasing would merge
	// case pairs the server distinguishes, replaying one variant's cached cells,
	// possibly empty, for the other). So typing through the sub-searchable
	// prefixes of a term ("b", "bu") never commits a new filter, and an
	// ASCII-case-only edit (which can't change the results) doesn't either.
	const querySignature = $derived(JSON.stringify({ query: foldAsciiCase(searchText), diet }));

	// Commit the live query into the store's `appliedFilter` whenever its
	// signature changes (the debounce and its bypass channels live in
	// ViewportData.scheduleCommit, which also hands back this effect's cleanup).
	$effect(() => {
		// Read the signature so the effect re-runs when (and only when) the
		// effective query changes; the value itself isn't otherwise needed.
		void querySignature;
		return viewportStore.scheduleCommit(searchText, diet);
	});

	// Load the visible box, one GRID CELL at a time, under the APPLIED filter —
	// the whole read lives in ViewportData.sync (see its doc comment for the
	// cell-store/prefetch design). Reactive on the viewport passed here plus the
	// store's own `appliedFilter` and store-version reads inside sync().
	$effect(() => {
		viewportStore.sync(viewport);
	});

	// Fallback opening centre (the shared Vancouver default, $lib/map-defaults),
	// used by "Start using" when IP geolocation is unavailable.
	const DEFAULT_CENTER = DEFAULT_MAP_CENTER;

	// A point to fly the map to; null leaves the camera alone. Only "Start using"
	// (the landing's entry button) flies the camera now — a search never moves
	// it: the map shows the matches wherever the user is looking, and panning is
	// how they look elsewhere. `key` is a monotonic nonce so <LocationMap> flies
	// exactly once per assignment.
	let focusTarget = $state<{ latitude: number; longitude: number; key: string } | null>(null);
	let focusNonce = 0;

	// The map page works against each location's fully-resolved `menu`, but the wire
	// payload sends each menu only once (keyed by menu_id) instead of copying it onto
	// every branch that serves it. resolveLocation ($lib/resolve-location, a pure
	// module so scripts/search-parity.test.ts exercises the same function) rebuilds
	// the effective menu — overrides applied — and attaches the menu's freshness
	// date and sources.
	const locations = $derived(
		viewportStore.data.locations.map((loc) => resolveLocation(loc, viewportStore.data))
	);

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

	// The live MapLibre instance, handed up by <LocationMap> once loaded (null before
	// then / after teardown). Passed to the landing overlay so it can position the
	// coverage figures in the 3D space around the globe (projected through the map's
	// own camera — see $lib/globe-space). The `maplibre-gl` import is type-only (erased
	// at build), so it pulls no map code into this page's bundle.
	let mapInstance = $state<MapLibreMap | null>(null);

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
	// edge geolocation — null when unavailable, so we fall back to the default
	// centre. The fly goes through the focus channel (a fresh nonce flies exactly
	// once); with no `zoom` override it pulls in to a city view.
	function startUsing(): void {
		const target = userLocation ?? { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };
		focusNonce += 1;
		focusTarget = { latitude: target.lat, longitude: target.lng, key: String(focusNonce) };
	}

	// A location with its FULL effective menu resolved (see resolveLocation), plus
	// its menu's `last_verified` freshness date (null for unverified/private menus)
	// and its menu-level `sources`. This is the detail-panel shape — only the by-id
	// fetch carries full Items; the in-view set resolves to lean MapItems (#83).
	type LocationData = ResolvedLocation<Item>;

	// One entry per location to show, paired with the items to tease under its marker.
	// The candidate set is whatever is currently visible on the map (`locations`). The
	// membership rule — venue-name OR item-name substring, diet always narrowing on the
	// same item, everything kept in browse mode — lives in $lib/search-match, a pure
	// module mirroring the server's cell-read filter (searchMembership, db.ts) so
	// scripts/search-parity.test.ts can hold the two halves to identical membership.
	// Under an applied filter the server already sent only matches; this narrows
	// the LIVE query over them — instant feedback for the keystrokes and short
	// prefixes the committed fetch hasn't (or won't) run for.
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

	// The count announced by the aria-live region. Only speaks once a real SEARCH
	// has settled: the APPLIED filter is non-empty (sub-searchable text commits
	// the empty filter, so "s"/"su" keystrokes never announce their transient
	// local narrowing), it still matches the live query (mid-debounce edits stay
	// silent), its cell fetch has returned, and that fetch SUCCEEDED — a failed
	// search must read as failed, not announce a definitive count computed from
	// stale markers.
	const searchSettled = $derived(
		(viewportStore.appliedFilter.q !== '' || viewportStore.appliedFilter.diet !== null) &&
			!viewportStore.searching &&
			viewportStore.fetchFailed === false &&
			viewportStore.appliedFilter.q === foldAsciiCase(searchText) &&
			viewportStore.appliedFilter.diet === diet
	);
	const resultsAnnouncement = $derived(
		searchSettled ? m.places_found({ count: results.length }) : ''
	);

	// Bound to the open detail panel; the focus $effect below moves keyboard
	// focus onto it whenever a location opens (from the results list, a map pill,
	// or a deep link), so it's never stranded on a control that just unmounted.
	let placecardEl = $state<HTMLElement | null>(null);

	// The map plots EVERY matching location — the map itself is the result surface.
	// Each carries the item names its label rotates through; a 30-branch chain
	// still drops 30 name pills.
	const mapLocations = $derived(
		results.map((result) => ({
			id: result.loc.id,
			name: result.loc.name,
			latitude: result.loc.latitude,
			longitude: result.loc.longitude,
			score: result.loc.score,
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
				if (!loc) {
					// The venue is gone (closed/deleted since the marker or link was
					// minted — stale cell-cache markers within their TTL, or a
					// /locations/<id> deep link to a since-closed place). Nulling only
					// `selectedLocation` would strand the user: the detail panel gates
					// on `selectedId && selectedLocation` and the searchbar on
					// `!selectedId`, so neither would render — a bare map with no way
					// back. Close the selection outright instead. `cancelled` above
					// guarantees this empty payload is for the CURRENT selection, so a
					// stale response for a superseded id can never close the new one.
					closeDetail();
					return;
				}
				selectedLocation = resolveLocation(loc, data);
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

	// Title, description and canonical URL for the venue head (SEO copy lives in
	// $lib/venue-head so scripts/venue-head.test.ts can pin it): the title leads
	// with the city and the description surfaces the menu's dietary coverage
	// (issue #222), and `url` is the canonical descriptive slug (issue #221). Null
	// keeps the static site-wide head.
	const headMeta = $derived(headVenue ? venueHeadMeta(headVenue) : null);

	// The schema.org FoodEstablishment JSON-LD for the same venue (issue #218): the
	// structured-data twin of the head copy above, carrying the venue's address,
	// coordinates and full menu (prices + per-item diet suitability) for rich
	// results. A ready-to-inject ld+json script string whose content is escaped in
	// $lib/venue-jsonld so a menu name or description can't break out of the script
	// tag, so the head renders it with {@html}. Null (no venue) keeps the head
	// markup-free.
	const headJsonLd = $derived(headVenue ? venueJsonLdScript(headVenue) : null);

	// Open Graph place metadata for the venue (issue #224): a venue page is a
	// physical place, so it declares the OG restaurant vertical (`restaurant.restaurant`,
	// which inherits the `place:location:*` geo properties) instead of the generic
	// `website` type, carrying the venue's exact OSM coordinates. Emitted verbatim,
	// the same coordinates the JSON-LD `geo` node and the map marker use. Null (no
	// open venue) leaves the head on its default `og:type website`.
	const ogPlace = $derived(
		headVenue ? { latitude: headVenue.latitude, longitude: headVenue.longitude } : null
	);

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
					score: selectedLocation.score,
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

	// --- Detail panel focus management -----------------------------------------
	// The panel behaves like a dialog: opening it moves keyboard focus onto the
	// aside (it carries tabindex="-1") so keyboard and screen-reader users land on
	// the panel instead of being stranded on the map or on a results button that
	// just unmounted; closing hands focus back to where it was. Driven by
	// `selectedId` rather than the open/close functions so EVERY close path
	// restores focus — the ✕ button, Escape, a bare-map click, and browser Back
	// (popstate), which never goes through `closeDetail`. The searchbar unmounts
	// while a detail is open, so the pre-open element is often gone by close time;
	// the close branch below picks a fallback that keeps keyboard users placed
	// without yanking focus (or a software keyboard) at pointer users.
	let detailReturnFocus: HTMLElement | null = null;
	// Effect-local bookkeeping (which transition just happened), not UI state.
	let detailWasOpen = false;
	$effect(() => {
		const open = Boolean(selectedId);
		const panel = placecardEl;
		if (open && !detailWasOpen) {
			// The panel can mount a beat after selection (deep link awaiting its
			// venue fetch): `panel` is a dependency, so the effect re-runs — and
			// `detailWasOpen` stays false — until it's bound.
			if (!panel) return;
			detailWasOpen = true;
			const active = document.activeElement;
			detailReturnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
			if (!panel.contains(active)) panel.focus();
		} else if (!open && detailWasOpen) {
			detailWasOpen = false;
			const saved = detailReturnFocus;
			detailReturnFocus = null;
			if (saved?.isConnected) {
				saved.focus();
			} else if (saved) {
				// The pre-open element unmounted with the searchbar (a keyboard user
				// selected from the results list): hand focus to the freshly remounted
				// search input — unless it's hidden (offsetParent is null then; focus()
				// would silently no-op) — else the map canvas (MapLibre gives it a tabindex).
				const input = document.querySelector<HTMLElement>('.searchpill__input');
				const target = input?.offsetParent
					? input
					: document.querySelector<HTMLElement>('.map canvas');
				target?.focus();
			} else if (panel?.contains(document.activeElement)) {
				// Nothing held focus before the open (a pointer user — taps don't focus
				// on iOS), but focus since landed inside the closing panel (its ✕
				// button): park it on the map canvas so it isn't dropped to <body>
				// when the panel unmounts. The canvas, unlike the search input, never
				// summons a software keyboard.
				document.querySelector<HTMLElement>('.map canvas')?.focus();
			}
			// Otherwise leave focus alone: a pointer-driven close never moved focus,
			// and grabbing the search input here would pop the on-screen keyboard.
		}
	});

	// Whether the account popover is open (bound below): while a detail is open
	// it's the only other window-level Escape consumer still mounted (the diet
	// selector unmounts with the searchbar), and Escape should close only the
	// topmost layer.
	let accountMenuOpen = $state(false);

	// Whether the sources modal (opened from the "N Sources" button in the detail
	// panel) is showing. Bound below so Escape can close it before the detail. Reset
	// whenever the open venue changes (tracked via `sourcesModalVenue`) so it never
	// lingers over a different place — covers every path that moves the selection,
	// including browser back/forward.
	let sourcesModalOpen = $state(false);
	let sourcesModalVenue: string | null = null;
	$effect(() => {
		if (selectedId !== sourcesModalVenue) {
			sourcesModalVenue = selectedId;
			sourcesModalOpen = false;
		}
	});

	// Escape closes the open detail — the keyboard counterpart to the bare-map
	// click. It yields to the account popover, which handles Escape itself; the
	// `defaultPrevented` check additionally covers any Escape consumer whose
	// window handler happened to run first.
	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || !selectedId || event.defaultPrevented) return;
		// Yield to any layer above the detail: the account popover and the sources
		// modal each handle Escape themselves, so it closes only the topmost one.
		if (accountMenuOpen || sourcesModalOpen) return;
		event.preventDefault();
		closeDetail();
	}

	// The canonical descriptive `/locations/<slug>` path for a to-be-selected id, so
	// the shallow-routing URL below carries the slug rather than a bare id. The
	// name/city come from the in-view set (`locations`, resolved) or the open venue
	// — the only ids a selection can name. An id in neither (a rare edge) falls back
	// to the bare form, which the server 301s to canonical on the next hard load.
	// A find() over the ≤200 in-view locations runs only on a select (a user action),
	// so it needs no memoised index.
	function locationHref(id: string): string {
		const loc =
			locations.find((l) => l.id === id) ?? (selectedLocation?.id === id ? selectedLocation : null);
		return loc ? locationPath(loc) : `/locations/${encodeURIComponent(id)}`;
	}

	function selectLocation(id: string): void {
		// Selecting a place (e.g. tapping a name pill on the map) sets `selectedId`,
		// which leaves the landing (see `landing`) so the detail card can show.
		// `/locations/<slug>` is a synthetic shallow-routing URL: there is no such
		// route (the `reroute` hook serves this root map page for it), so the address
		// bar can reflect the open location — as the canonical, shareable descriptive
		// URL — without a real navigation. Because it isn't a real route it can't go
		// through the typed `resolve(routeId)`, hence the lint exception on the calls
		// below.
		const url = locationHref(id);
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
	// needn't wait on the user read. Both reads are OPTIONAL account extras over a
	// public map, so — like the userLocation/landingData awaits above — a transient
	// failure (a D1 hiccup on the session read) must degrade to the signed-out UI,
	// never 500 the SSR render or break hydration for the whole page. The catches
	// fold a failure into exactly the signed-out shapes the reads return themselves.
	const user = $derived(await getCurrentUser().catch(() => null));
	const serverLikes = $derived(
		await getLikes().catch(() => ({ locationIds: [] as string[], itemIds: [] as string[] }))
	);

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

	// Serializes the like commands per liked thing ($lib/like-queue): without it,
	// two rapid taps on one heart race their writes — the unlike can land on D1
	// before the like it undoes, persisting the opposite of the UI — and an old
	// failure's revert can clobber a newer tap's optimistic state. The queue sends
	// writes for a key strictly in tap order, skips superseded ones (the latest
	// tap carries the final desired state) and gates each revert on still being
	// the latest. Non-reactive plumbing, like the pending maps' sibling memos.
	const likeQueue = createLikeQueue();

	function toggleLocationLike(id: string) {
		const liked = likedLocationIds.has(id);
		pendingLocationLikes.set(id, !liked);
		likeQueue.enqueue(
			`location:${id}`,
			() => setLocationLiked({ locationId: id, liked: !liked }),
			() => pendingLocationLikes.set(id, liked)
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
		likeQueue.enqueue(
			`item:${id}`,
			() => setItemLiked({ itemId: id, liked: !liked }),
			() => pendingItemLikes.set(id, liked)
		);
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<svelte:head>
	<!-- Warm the OSM raster-tile connections early (issue #224): the map is this
	     route's LCP element, so its tiles come from a/b/c.tile.openstreetmap.org
	     (see LocationMap.svelte) — a `preconnect` shaves the TLS handshake off the
	     first tile fetch. `crossorigin` matches MapLibre's anonymous CORS tile
	     fetch, so the warmed connection is actually reused. Revisit when the
	     Protomaps/R2 migration moves tiles to a single PMTiles origin. -->
	<link rel="preconnect" href="https://a.tile.openstreetmap.org" crossorigin="anonymous" />
	<link rel="preconnect" href="https://b.tile.openstreetmap.org" crossorigin="anonymous" />
	<link rel="preconnect" href="https://c.tile.openstreetmap.org" crossorigin="anonymous" />
	{#if headMeta}
		<!-- Venue head for an open location. On a hard /locations/<id> load this is
		     already in the server-rendered HTML (see the landing-venue fetch above),
		     so link unfurlers and crawlers see the venue rather than the site
		     defaults. Svelte escapes text and attribute content here, so the venue
		     fields need no hand-escaping. -->
		<title>{headMeta.title}</title>
		<meta name="description" content={headMeta.description} />
		<!-- The canonicalization signal (og:url is not one): points query-string or
		     stale-slug variants of this venue's URL at the one address the sitemap
		     lists, matching the server's 301 target. -->
		<link rel="canonical" href={headMeta.url} />
		<meta property="og:title" content={headMeta.title} />
		<meta property="og:description" content={headMeta.description} />
		<meta property="og:site_name" content="BetterFoodMaps" />
		<meta property="og:url" content={headMeta.url} />
		<!-- A venue page is a physical place: the OG restaurant vertical (issue #224)
		     carries the venue's exact OSM coordinates for geo-aware unfurlers, and
		     inherits the `place:location:*` properties the generic `website` type
		     lacks. `ogPlace` is non-null here (it derives from the same `headVenue`
		     that gates `headMeta`), so the guard is only for the compiler's null
		     narrowing — the venue head always emits the restaurant vertical. -->
		{#if ogPlace}
			<meta property="og:type" content="restaurant.restaurant" />
			<meta property="place:location:latitude" content={String(ogPlace.latitude)} />
			<meta property="place:location:longitude" content={String(ogPlace.longitude)} />
		{/if}
		<!-- schema.org JSON-LD (issue #218): the machine-readable venue graph
		     crawlers parse for rich results, built in $lib/venue-jsonld and injected
		     raw — its content is escaped there so a menu name or description can't
		     break out of the script tag. -->
		{#if headJsonLd}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html headJsonLd}
		{/if}
	{:else}
		<title>BetterFoodMaps</title>
		<meta name="description" content={m.head_site_description()} />
		<!-- The map root canonicalizes to the bare origin, so query-string variants
		     (shared links, campaign params) don't fragment its indexing. -->
		<link rel="canonical" href="{CANONICAL_ORIGIN}/" />
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
			onmap={(m) => (mapInstance = m)}
		/>
	</div>

	<!-- The open location's page details: a panel docked to the right edge (a bottom
	     sheet on narrow screens) beside the map, which keeps the venue centred in the
	     space the panel leaves it (see detailInset). Slides in on select and away on
	     close/deselect. Gated on `selectedId` so closing starts the slide-out at once;
	     the content reads the retained `selectedLocation`, which stays valid through
	     the outro. -->
	{#if selectedId && selectedLocation}
		<VenueDetail
			location={selectedLocation}
			{user}
			{likedLocationIds}
			{likedItemIds}
			onToggleLocationLike={toggleLocationLike}
			onToggleItemLike={toggleItemLike}
			onClose={closeDetail}
			flyParams={panelFly}
			bind:sourcesOpen={sourcesModalOpen}
			bind:el={placecardEl}
		/>
	{/if}

	<!-- The landing overlay: coverage stats + entry buttons, shown over the zoomed-out
	     globe. It's zoom-driven (see `landing`): it appears whenever the map is zoomed
	     out and returns if the visitor zooms back out. -->
	{#if landing}
		<MapStatsOverlay {stats} map={mapInstance} onstart={startUsing} />
	{/if}

	<!-- The search controls don't live in a panel: each is its own pill floating
	     free over the map, laid out as a horizontal row anchored top-left. On narrow
	     screens the row floats centered at the bottom of the screen (all items always
	     visible), while the account control stays pinned to the top-left corner. -->
	<div class="searchbar" role="search" aria-label={m.search_bar_aria()}>
		<AccountMenu {user} bind:open={accountMenuOpen} />

		<!-- Search and filter controls are hidden while the landing overlay is up (the
		     globe is just a backdrop then) AND while a location is open (its detail
		     panel owns the page then); only the account control stays. They return the
		     moment the visitor leaves the landing state or closes the location. -->
		{#if !landing && !selectedId}
			<div class="searchbar__items">
				<!-- The combined search: one pill matching a venue by name OR by an item
			     name. A label so a click anywhere in the pill (the search icon included)
			     focuses the input; the input is the only control inside it. -->
				<label class="searchpill searchpill--search">
					<input
						class="searchpill__input"
						type="search"
						placeholder={m.search_placeholder()}
						aria-label={m.search_input_aria()}
						bind:value={query}
						onkeydown={(event) => {
							// Enter is a deliberate "search now": fire any pending debounce
							// at once (no-op when nothing is pending — see flushSearch).
							if (event.key === 'Enter') viewportStore.flushSearch?.();
						}}
						onpaste={() => {
							// A paste lands whole, with no keystroke burst to coalesce: arm
							// the one-shot bypass so the value change fires immediately.
							viewportStore.searchImmediate = true;
						}}
					/>
					{#if viewportStore.searching}
						<!-- Replaces the search glyph while the global search round trip is
						     in flight, so latency is visible right where the user typed. -->
						<span class="searchpill__spinner" aria-hidden="true"></span>
					{:else}
						<Search class="searchpill__icon" size={16} aria-hidden="true" />
					{/if}
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
				<nav class="results" aria-label={m.results_nav_aria()}>
					<ul class="results__list">
						{#each listedResults as result (result.loc.id)}
							<li>
								<button
									type="button"
									class="results__item"
									onclick={() => selectLocation(result.loc.id)}
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
							{m.results_cap({ max: RESULTS_LIST_MAX, total: results.length })}
						</p>
					{/if}
				</nav>
			{/if}

			<!-- A failed search/viewport fetch keeps the previous markers on screen (see
			     the fetch effects), so say so here rather than leaving the map looking
			     silently stale or empty. Announced via the always-mounted live region
			     below (regions added on the fly aren't reliably picked up), so this
			     visible copy is hidden from assistive tech to avoid a double read. -->
			{#if fetchStatus}
				<p class="searchstatus" aria-hidden="true">{fetchStatus}</p>
			{/if}
		{/if}
	</div>

	<!-- Announces how many places a search matched, once each search settles.
	     Always in the DOM (an aria-live region added on the fly isn't reliably
	     picked up); empty while browsing, so pans announce nothing. -->
	<div class="visually-hidden" role="status">{resultsAnnouncement}</div>

	<!-- The aria-live twin of the visible status line above: announces a failed
	     search/viewport fetch. Same always-in-the-DOM rule as the count region. -->
	<div class="visually-hidden" role="status">{fetchStatus}</div>
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
	   query below turns it into its own centered row at the bottom of the screen. */
	.searchbar__items {
		display: contents;
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

	/* The in-flight search indicator, swapped in for the search glyph. Same 16px
	   footprint as the icon so the pill doesn't shift when it appears. */
	.searchpill__spinner {
		flex-shrink: 0;
		width: 16px;
		height: 16px;
		border: 2px solid rgba(0, 0, 0, 0.12);
		border-top-color: var(--color-accent);
		border-radius: 50%;
		animation: searchpill-spin 0.7s linear infinite;
	}

	@keyframes searchpill-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.searchpill__spinner {
			animation-duration: 2s;
		}
	}

	/* Fetch-failure status: its own full row under the search pills (the searchbar
	   wraps), in the same glass family but tinted so it reads as a warning. */
	.searchstatus {
		width: 100%;
		align-self: stretch;
		margin: 0;
		padding: 0.4rem 0.7rem;
		font-size: 0.78rem;
		font-weight: 600;
		color: #9a3412;
		background: rgba(255, 247, 237, 0.92);
		border: 1px solid rgba(154, 52, 18, 0.25);
		border-radius: 0.7rem;
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
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

	/* Below ~48rem the search row floats centered at the BOTTOM of the screen (all
	   items always visible — no collapse toggle), while the account/sign-in control is
	   pulled out to the top-left corner. The map card already adapts via its own width
	   clamp. Center via symmetric left/right rather than a transform: a transformed
	   ancestor would become the containing block for the position:fixed account below,
	   pinning it to the bottom searchbar instead of the viewport. */
	@media (max-width: 48rem) {
		.searchbar {
			top: auto;
			left: calc(1rem + env(safe-area-inset-left));
			right: calc(1rem + env(safe-area-inset-right));
			bottom: calc(1rem + env(safe-area-inset-bottom));
			max-width: none;
			flex-direction: column;
			flex-wrap: nowrap;
			align-items: center;
		}

		/* The account/sign-in control stays anchored in the top-left corner, out of the
		   bottom search row's flow (fixed to the viewport, not the searchbar). */
		.searchbar :global(.account) {
			position: fixed;
			top: calc(1rem + env(safe-area-inset-top));
			left: calc(1rem + env(safe-area-inset-left));
			z-index: 11;
		}

		/* The items become a centered, full-width wrapping row. */
		.searchbar__items {
			display: flex;
			flex-wrap: wrap;
			justify-content: center;
			gap: 0.5rem;
			width: 100%;
		}

		/* 16px inputs stop iOS Safari from auto-zooming the page when one is focused. */
		.searchpill__input {
			font-size: 1rem;
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
