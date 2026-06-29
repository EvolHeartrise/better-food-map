<script lang="ts">
	import { resolve } from '$app/paths';
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { MediaQuery, SvelteSet, SvelteMap } from 'svelte/reactivity';
	import {
		getLocations,
		getLocationData,
		searchLocations,
		getStats,
		getUserLocation
	} from '$lib/data.remote';
	import { getCurrentUser, getLikes, setLocationLiked } from '$lib/user.remote';
	import { getDiet, setDiet } from '$lib/profile.remote';
	import LocationMap from '$lib/components/LocationMap.svelte';
	import MapStatsOverlay from '$lib/components/MapStatsOverlay.svelte';
	import DietSelector from '$lib/components/DietSelector.svelte';
	import FoodTag from '$lib/components/FoodTag.svelte';
	import AccountMenu from '$lib/components/AccountMenu.svelte';
	import LikeButton from '$lib/components/LikeButton.svelte';
	import Search from '@lucide/svelte/icons/search';
	import { categoryLabel } from '$lib/category';
	import type { MapData, MapLocation, Item, Bounds } from '$lib/server/db';

	// The visible map area, reported by <LocationMap> (debounced) as the user pans
	// and zooms, plus once on load. This is the ONLY thing that decides which data
	// we fetch — the area filter is now "whatever's on screen". Null until the map
	// has mounted and reported its opening view.
	let viewport = $state<Bounds | null>(null);

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

	// The filters, normalised once and shared by the map item labels, the selected-
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
	// with no filter active every visible place is shown; the inputs only narrow it.
	// Item-level inputs drive the per-venue matched list (used for the scattered item
	// labels); with none active, `items` is empty.
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

	// The map plots EVERY matching location (the chain-branch grouping the old results
	// list did is gone — the map itself is the result surface now). A 30-branch chain
	// still drops 30 name pills.
	const mapLocations = $derived(results.map((result) => result.loc));

	// In-view locations keyed by id, so an item-label tap can resolve back to its
	// venue's resolved menu for the details popup.
	const locationById = $derived(new Map(locations.map((loc) => [loc.id, loc])));

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
	let landingId = $state(idFromPath(page.url.pathname));
	const selectedId = $derived(page.state.selected ?? landingId);

	// True while the landing should show (see the WORLD_ZOOM block): the map is zoomed out
	// onto the globe with nothing open. An open location (including a `/locations/<id>`
	// deep link, via `selectedId`) always takes precedence, and zooming back out brings the
	// landing back. While it's up, the search controls are hidden so the globe and the two
	// floating landing pieces are all that show.
	const landing = $derived(!selectedId && (zoomLevel === null || zoomLevel <= LANDING_MAX_ZOOM));

	// The resolved record for the open location. Because we now load only the
	// visible area, the selected place isn't always among `locations` — a shared
	// `/locations/<id>` link, or one panned off screen, falls outside it. So we
	// resolve it from the in-view set when present and otherwise fetch it by id.
	// Held in state (not a derived) and updated imperatively so the open detail
	// stays put while a by-id fetch is in flight — panning the place off screen
	// doesn't flash the card closed.
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

	// Below this width the selected venue's menu is shown as a scrollable list inside
	// its detail card instead of as an on-map cluster — there's no room for a fanned-out
	// cluster of labels beside the near-full-width card on a phone.
	const narrowMap = new MediaQuery('(max-width: 48rem)');

	// The menu-item labels plotted on the map. Each venue's labels fan out as a force-
	// laid-out cluster around its name pill (see <LocationMap>), so they're capped PER
	// venue — a radial cluster only stays readable up to ~10–14 labels, and a deep menu
	// would otherwise bury the map. Two cases:
	//   1. the selected venue (the showcase): up to SELECTED_MENU_CAP items of its menu,
	//      in menu order. A deeper menu is truncated and the card notes the remainder;
	//      on a narrow screen the cluster is suppressed (the card lists the menu instead).
	//   2. when a filter is active: the matching items at every OTHER visible venue,
	//      nearest first — at most FILTER_VENUE_CAP per venue, the last being a
	//      "+N more" chip that selects the venue (revealing its full cluster).
	// A global MAX_MAP_ITEM_LABELS backstops the total. `groupId` tags a venue's labels;
	// ids are an injective (venue, item) JSON tuple.
	const MAX_MAP_ITEM_LABELS = 80;
	const SELECTED_MENU_CAP = 10;
	const FILTER_VENUE_CAP = 2;
	// Sentinel item id for a "+N more" chip; tapping it selects the venue rather than
	// opening an item popup (see openItemLabel).
	const MORE_ITEM_ID = '__more__';
	type MapItemLabel = {
		id: string;
		groupId: string;
		locationId: string;
		itemId: string;
		name: string;
		latitude: number;
		longitude: number;
	};
	const itemLabels = $derived.by(() => {
		const out: MapItemLabel[] = [];
		const push = (loc: LocationData, itemId: string, name: string) => {
			out.push({
				id: JSON.stringify([loc.id, itemId]),
				groupId: loc.id,
				locationId: loc.id,
				itemId,
				name,
				latitude: loc.latitude,
				longitude: loc.longitude
			});
		};

		const sel = selectedLocation;
		// Selected venue: its menu as a cluster (capped), unless the screen is too
		// narrow — then the card lists it instead (see the detail card snippet).
		if (sel && !narrowMap.current) {
			for (const menuItem of sel.menu.slice(0, SELECTED_MENU_CAP)) {
				push(sel, menuItem.id, menuItem.item_name);
			}
		}

		// Filter matches at every other visible venue: a few chips each, "+N more" last.
		if (hasItemFilter) {
			for (const result of results) {
				if (sel && result.loc.id === sel.id) continue;
				const matched = result.items;
				if (matched.length <= FILTER_VENUE_CAP) {
					for (const menuItem of matched) push(result.loc, menuItem.id, menuItem.item_name);
				} else {
					for (const menuItem of matched.slice(0, FILTER_VENUE_CAP - 1)) {
						push(result.loc, menuItem.id, menuItem.item_name);
					}
					push(result.loc, MORE_ITEM_ID, `+${matched.length - (FILTER_VENUE_CAP - 1)} more`);
				}
			}
		}
		return out.slice(0, MAX_MAP_ITEM_LABELS);
	});

	function idFromPath(pathname: string): string | null {
		const match = pathname.match(/\/locations\/([^/]+)$/);
		return match ? decodeURIComponent(match[1]) : null;
	}

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
		// Closing the detail also dismisses any open item popup.
		closeItemPopup();
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

	// --- Item details popup ----------------------------------------------------
	// Tapping a menu-item label on the map opens a small popup with that item's
	// price, description and tags/sources, positioned at the tapped point (clamped to
	// the viewport) and dismissed by tapping elsewhere or panning. It's
	// non-interactive (pointer-events: none) — a quick read, not a control surface.
	const POPUP_GAP = 12;
	let popupItem = $state<Item | null>(null);
	let popupAt = $state<{ x: number; y: number } | null>(null);
	let popupEl = $state<HTMLElement>();

	// Resolve a tapped item label (venue id + item id) to its resolved Item and open
	// the popup at the tap point. The item comes from the venue's resolved menu —
	// the in-view set when present, else the open location. A "+N more" chip carries
	// no real item: tapping it selects the venue, revealing its full menu column.
	function openItemLabel(
		locationId: string,
		itemId: string,
		point: { x: number; y: number }
	): void {
		if (itemId === MORE_ITEM_ID) {
			selectLocation(locationId);
			return;
		}
		const loc =
			locationById.get(locationId) ??
			(selectedLocation?.id === locationId ? selectedLocation : null);
		const found = loc?.menu.find((menuItem) => menuItem.id === itemId) ?? null;
		if (!found) return;
		popupItem = found;
		popupAt = point;
	}

	function closeItemPopup(): void {
		popupItem = null;
		popupAt = null;
	}

	// Position the popup near the tap, flipping/clamping so it stays fully on screen.
	$effect(() => {
		const el = popupEl;
		const at = popupAt;
		if (!el || !at) return;
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		let left = at.x + POPUP_GAP;
		let top = at.y + POPUP_GAP;
		if (left + w + POPUP_GAP > window.innerWidth) left = at.x - w - POPUP_GAP;
		if (top + h + POPUP_GAP > window.innerHeight) top = window.innerHeight - h - POPUP_GAP;
		el.style.left = `${Math.max(POPUP_GAP, left)}px`;
		el.style.top = `${Math.max(POPUP_GAP, top)}px`;
	});

	// A pointerdown anywhere outside the popup closes it — this also means starting a
	// map pan (a pointerdown on the canvas) dismisses it. The map's own click reopens
	// it for a fresh item, since click fires after this pointerdown.
	$effect(() => {
		if (!popupItem) return;
		function onPointerDown(event: PointerEvent) {
			if (popupEl?.contains(event.target as Element | null)) return;
			closeItemPopup();
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
			{itemLabels}
			selected={selectedLocation}
			onselect={selectLocation}
			onitemselect={openItemLabel}
			initialCenter={WORLD_CENTER}
			initialZoom={WORLD_ZOOM}
			onzoom={(z) => (zoomLevel = z)}
			focus={focusTarget}
			onviewchange={(bounds) => (viewport = bounds)}
		>
			<!-- The selected venue's detail card, rendered by the map at the venue's
			     point. Holds the location info the old right panel did; the menu now
			     lives on the map as item labels fanning out from this pill. -->
			{#snippet detailCard()}
				{#if selectedLocation}
					{@const loc = selectedLocation}
					{@const label = categoryLabel(loc.category)}
					<div class="placecard">
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

						<!-- On a narrow screen there's no room for an on-map menu cluster beside
						     the near-full-width card, so the menu is listed in the card instead
						     (its labels are suppressed in `itemLabels`). Each row taps through to
						     the same item popup. -->
						{#if narrowMap.current && loc.menu.length > 0}
							<ul class="placecard__menu">
								{#each loc.menu as menuItem (menuItem.id)}
									<li>
										<button
											type="button"
											class="placecard__item"
											onclick={(event) =>
												openItemLabel(loc.id, menuItem.id, { x: event.clientX, y: event.clientY })}
										>
											<span class="placecard__item-line">
												<span class="placecard__item-name">{menuItem.item_name}</span>
												<span class="placecard__item-price">
													{formatPrice(menuItem.price, menuItem.currency)}
												</span>
											</span>
											{@render dietaryBadges(menuItem)}
										</button>
									</li>
								{/each}
							</ul>
						{/if}

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
							{:else if narrowMap.current}
								<span class="placecard__hint">
									{loc.menu.length}
									{loc.menu.length === 1 ? 'item' : 'items'}
								</span>
							{:else if loc.menu.length > SELECTED_MENU_CAP}
								<span class="placecard__hint">
									Showing {SELECTED_MENU_CAP} of {loc.menu.length} — tap a label for details.
								</span>
							{:else}
								<span class="placecard__hint">Tap an item label for details.</span>
							{/if}
						</footer>
					</div>
				{/if}
			{/snippet}
		</LocationMap>
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

	<!-- An item's DIETARY tags (vegan, gluten-free, halal, …) only, rendered inline
	     wherever the item appears so the diet markers are visible at a glance rather
	     than hidden behind the popup. Course tags stay in itemExtras.
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

	<!-- The item's course tag and its data sources, shown in the popup. Dietary tags
	     are shown inline on the row above (see dietaryBadges), so they're omitted here
	     to avoid repeating them. An `optional` tag keeps its dashed marker. -->
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

	<!-- The tapped item label's details, floating over the map at the tap point. It's
	     non-interactive (pointer-events: none), so it never blocks the map beneath it;
	     a tap elsewhere (or a pan) dismisses it. -->
	{#if popupItem}
		<div class="menu-popup" role="tooltip" bind:this={popupEl}>
			<div class="menu__line">
				<span class="menu__name">{popupItem.item_name}</span>
				<span class="menu__price">{formatPrice(popupItem.price, popupItem.currency)}</span>
			</div>
			{#if popupItem.description}
				<span class="menu__description">{popupItem.description}</span>
			{:else}
				<span class="menu__description menu__description--empty">No description</span>
			{/if}
			{@render dietaryBadges(popupItem)}
			{@render itemExtras(popupItem)}
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
	   context so the floating controls (z-index 10) sit above every MapLibre pane. */
	.app__map {
		position: absolute;
		inset: 0;
		z-index: 0;
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

	/* --- Selected-venue detail card (on the map, by its pill) ----------------- */
	/* Positioned by <LocationMap>; this is its surface — the glass panel that holds
	   the venue info the old right panel's detail header/info block did. */
	.placecard {
		position: relative;
		width: min(20rem, calc(100vw - 2rem));
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.85rem 0.95rem;
		border-radius: 0.9rem;
		background: rgba(255, 255, 255, 0.92);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 10px 34px rgba(0, 0, 0, 0.22);
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

	/* Narrow-screen in-card menu list, used in place of the on-map item column.
	   Scrolls within a capped height so a long menu doesn't make the card overflow
	   the viewport. */
	.placecard__menu {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 40dvh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}

	.placecard__item {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		width: 100%;
		appearance: none;
		text-align: left;
		color: inherit;
		background: none;
		border: none;
		border-top: 1px solid rgba(0, 0, 0, 0.06);
		padding: 0.45rem 0.1rem;
		cursor: pointer;
	}

	.placecard__menu li:first-child .placecard__item {
		border-top: none;
	}

	.placecard__item:hover .placecard__item-name,
	.placecard__item:focus-visible .placecard__item-name {
		color: var(--color-accent);
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
	}

	.placecard__item-price {
		font-size: 0.82rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
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

	/* The name/price line and description, shared by the item popup. */
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

	/* Inline variant: the dietary badges shown directly on the popup, with a tighter
	   top margin so they hug the row above. */
	.taglist--inline {
		margin-top: 0.3rem;
	}

	/* Provenance for the item. The popup is non-interactive (pointer-events: none),
	   so these are shown as plain labels/hostnames rather than clickable links; the
	   detail card renders its own sources as real links. */
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

	/* The item details popup floats over the map at the tapped point. The positioning
	   effect sets its `top`/`left`; it's non-interactive so it never steals a tap from
	   the map beneath it. A touch higher opacity than the controls keeps text legible
	   over the map. */
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

	/* Below ~48rem let the search row span the top (its items wrapping into their own
	   row, foldable by the toggle); the map card and popup already adapt via their own
	   width clamps. */
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

		.place-card__clear {
			width: 1.9rem;
			height: 1.9rem;
			font-size: 1rem;
		}
	}
</style>
