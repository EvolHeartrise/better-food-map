<script lang="ts">
	import { fly, type FlyParams } from 'svelte/transition';
	import DietaryIcons from '$lib/components/DietaryIcons.svelte';
	import DirectionsModal from '$lib/components/DirectionsModal.svelte';
	import SourcesModal from '$lib/components/SourcesModal.svelte';
	import LikeButton from '$lib/components/LikeButton.svelte';
	import { categoryLabel } from '$lib/category';
	import { tagDisplayName } from '$lib/tags';
	import { safeHttpUrl } from '$lib/safe-url';
	import { formatPhone } from '$lib/phone';
	import {
		weeklyHoursFromJson,
		groupWeeklyHours,
		weekdayName,
		formatMinutes,
		type HoursRow
	} from '$lib/opening-hours';
	import { tooltip } from '$lib/tooltip';
	import { shouldDismissSheet } from '$lib/bottom-sheet';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { ResolvedLocation } from '$lib/resolve-location';
	import type { Item, User } from '$lib/server/db';

	// The open location's detail panel: a column docked to the right edge (a
	// bottom sheet on narrow screens) beside the map, rendering the venue's info
	// block and its FULL effective menu — each item's price, description and
	// dietary markers, browsable by course (All/Food/Dessert/Drinks) rather than
	// diet-filtered. The page owns the selection (what's open, URL/history,
	// focus management) and the like state; this component owns the panel's DOM.
	// `el` is bindable so the page's focus effect can target the aside;
	// `sourcesOpen`/`directionsOpen` are bindable so the page can layer its
	// window-level Escape handling under those modals' (Escape closes only the
	// topmost layer).
	let {
		location,
		user,
		likedLocationIds,
		likedItemIds,
		onToggleLocationLike,
		onToggleItemLike,
		onClose,
		flyParams,
		narrow = false,
		sourcesOpen = $bindable(false),
		directionsOpen = $bindable(false),
		el = $bindable(null)
	}: {
		location: ResolvedLocation<Item>;
		user: User | null;
		likedLocationIds: ReadonlySet<string>;
		likedItemIds: ReadonlySet<string>;
		onToggleLocationLike: (id: string) => void;
		onToggleItemLike: (id: string) => void;
		onClose: () => void;
		flyParams: FlyParams;
		// On a phone (`narrow`) the panel is a full-screen sheet the user can swipe
		// down to dismiss (see the touch handlers below). On wide screens `narrow`
		// is false and the gesture is inert — the panel is a fixed right-hand column.
		narrow?: boolean;
		sourcesOpen?: boolean;
		directionsOpen?: boolean;
		el?: HTMLElement | null;
	} = $props();

	const loc = $derived(location);
	const label = $derived(categoryLabel(loc.category));
	// Phone rendered on read: one consistent display + a fully-qualified tel: href,
	// regardless of how the source spelled the stored number (issue #241).
	const phone = $derived(formatPhone(loc.phone, loc.country));

	// Weekly hours as grouped display rows (consecutive same-hours days collapse,
	// e.g. Mo–Fr). Null when the venue's stored hours aren't machine-readable
	// (opening_hours_json is derived-on-write from the raw OSM-syntax string; the
	// ~3% beyond the parsed subset) — the row then shows the raw string verbatim.
	const hoursRows = $derived.by(() => {
		const week = weeklyHoursFromJson(loc.opening_hours_json);
		return week ? groupWeeklyHours(week) : null;
	});

	// Day names and times render through Intl (no per-locale catalog keys):
	// "Mon–Fri" / "lun.–ven.", "11:00 a.m.–2:00 p.m." per the active locale.
	function hoursDayLabel(row: HoursRow): string {
		const locale = getLocale();
		const first = weekdayName(row.days[0], locale);
		if (row.days.length === 1) return first;
		return `${first}–${weekdayName(row.days[row.days.length - 1], locale)}`;
	}

	function hoursTimesLabel(row: HoursRow): string {
		const locale = getLocale();
		return row.spans
			.map(([open, close]) => `${formatMinutes(open, locale)}–${formatMinutes(close, locale)}`)
			.join(', ');
	}

	// Price formatters, one per (locale, ISO-4217 currency code): each item carries
	// its menu's currency, and the number itself is grouped/positioned per the active
	// locale (fixed per page load), so a mixed-currency result set still formats every
	// price in its own currency AND the reader's number format. Built lazily and cached
	// keyed on `locale:code` — keying on locale too keeps different-locale renders from
	// colliding on a shared entry. A plain record, not a Map — a non-reactive memo
	// cache, never component state.
	const moneyFormatters: Record<string, Intl.NumberFormat> = {};
	function moneyFormatter(code: string): Intl.NumberFormat {
		const locale = getLocale();
		return (moneyFormatters[`${locale}:${code}`] ??= new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: code
		}));
	}

	function formatPrice(price: number, code: string): string {
		return moneyFormatter(code).format(price);
	}

	// --- Menu course filter ------------------------------------------------------
	// The horizontally-scrolling category row above the menu list: All / Food /
	// Dessert / Drinks.
	// Buckets come from the required course tags — Food is ABSENCE-based (neither
	// dessert nor drink), so items from before the course-tag mandate (no course
	// tag at all) still land somewhere sensible while the backlog drains. An item
	// tagged both dessert and drink (a milkshake) appears under both. An OPTIONAL
	// course tag never buckets (writes reject those now; pre-mandate data has none).
	// Each course tab's label comes from the shared tagDisplayName ($lib/tags),
	// keyed by the course id — one source of truth for course display names.
	type CourseFilter = 'all' | 'food' | 'dessert' | 'drink';

	function hasCourse(item: Item, id: 'dessert' | 'drink'): boolean {
		return item.tags.some((tag) => tag.id === id && !tag.optional);
	}

	const courseBuckets = $derived({
		food: loc.menu.filter((item) => !hasCourse(item, 'dessert') && !hasCourse(item, 'drink')),
		dessert: loc.menu.filter((item) => hasCourse(item, 'dessert')),
		drink: loc.menu.filter((item) => hasCourse(item, 'drink'))
	});
	// Only categories with items get a tab; the whole row disappears when the
	// menu is single-category (an all-food diner, an all-drinks tea shop).
	const courseOptions = $derived(
		(['food', 'dessert', 'drink'] as const).filter((c) => courseBuckets[c].length > 0)
	);

	// The selection is remembered per venue id (no effect needed): switching to
	// another venue reads as 'all' until a tab is clicked there.
	let pickedCourse = $state<CourseFilter>('all');
	let pickedForId = $state('');
	const course = $derived.by((): CourseFilter => {
		if (pickedForId !== loc.id || pickedCourse === 'all') return 'all';
		// Guard against a stale pick (menu changed under the same id).
		return courseBuckets[pickedCourse].length > 0 ? pickedCourse : 'all';
	});
	function selectCourse(c: CourseFilter, tab?: HTMLElement) {
		pickedForId = loc.id;
		pickedCourse = c;
		// A tab tapped while clipped at the row's edge slides fully into view
		// (Google Maps-style); the pace comes from the row's CSS scroll-behavior,
		// which prefers-reduced-motion resets to instant.
		tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	const visibleMenu = $derived(course === 'all' ? loc.menu : courseBuckets[course]);

	// --- Menu freshness --------------------------------------------------------
	// A menu carries a `last_verified` ISO date (the day it was last checked against
	// its source). We surface it as a relative "Scanned …" phrase beside the Menu
	// header so a stale chain menu reads as such.
	//
	// The stored value is a plain calendar day, not an instant, so we compare
	// calendar dates in the user's LOCAL timezone. `new Date('YYYY-MM-DD')` would
	// parse as UTC midnight, and diffing that against Date.now() makes a menu
	// scanned today read "Scanned yesterday" for part of the day anywhere west
	// of UTC (at 5pm PDT the clock is already ≥24h past UTC midnight). So we pull
	// the y/m/d out ourselves, build both sides as local midnights, and Math.round
	// the difference to absorb the ±1h a DST boundary injects.
	function verifiedDaysAgo(iso: string): number | null {
		const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
		if (!match) return null;
		const then = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		return Math.round((today.getTime() - then.getTime()) / 86_400_000);
	}
	// The relative phrase ("today" / "yesterday" / "3 days ago" / "last month" /
	// "last year") is produced by Intl.RelativeTimeFormat in the active locale, so
	// the plural/word forms are localized for free; we keep only the day-bucketing
	// (which coarse unit to phrase in) and wrap the result in the localized "Scanned
	// {relative}" so the surrounding verb still translates. `numeric: 'auto'` is what
	// yields the natural "today"/"yesterday"/"last month" rather than "0 days ago".
	function formatScanned(iso: string): string {
		const days = verifiedDaysAgo(iso);
		if (days === null) return m.scanned_date({ date: iso });
		const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
		let relative: string;
		if (days < 30) {
			// A future/zero diff clamps to 0 ("today"); otherwise negative = in the past.
			relative = rtf.format(days <= 0 ? 0 : -days, 'day');
		} else {
			const months = Math.round(days / 30);
			relative =
				months < 12 ? rtf.format(-months, 'month') : rtf.format(-Math.round(days / 365), 'year');
		}
		return m.scanned({ relative });
	}

	// --- Swipe-down dismiss (narrow screens) --------------------------------------
	// On a phone the panel is a FULL-SCREEN sheet with no intermediate resting
	// heights. At rest it simply FILLS its container (CSS `inset: 0` — the same
	// box as the map, so it always fits the screen exactly; no JS viewport
	// measurement, which desyncs from the layout viewport around mobile browser
	// URL bars). A dismiss drag slides it down with a translateY offset — never a
	// resize — and releasing either dismisses the panel (see shouldDismissSheet)
	// or springs the offset back to zero.
	let dragOffset = $state<number | null>(null);
	let dragging = $state(false);

	// Drag bookkeeping — plain locals, read only inside the handlers.
	let dragStartY = 0;
	// The panel's rendered height, measured when a drag captures — the offset
	// clamp and the halfway dismiss threshold both compare against it.
	let dragPanelHeight = 0;
	let lastTouchY = 0;
	let lastTouchT = 0;
	// Offset velocity near release (px/ms, + = moving down), for the flick that
	// dismisses regardless of distance (shouldDismissSheet).
	let dragVelocity = 0;

	// The gesture is recognised on the whole panel (attached to the aside in the
	// $effect below), so a swipe down on the header dismisses just like one on the
	// menu. The rules per gesture, decided on its FIRST touchmove and held until
	// the finger lifts (browsers commit a touch sequence to native scrolling once
	// a touchmove goes unprevented, so a gesture can't switch modes midway):
	//   • a predominantly horizontal swipe is never a sheet drag — it belongs to
	//     a horizontal scroller inside the body (the course-tab strip);
	//   • a downward pull grabs the sheet, UNLESS it starts inside the scrolled
	//     menu list — the panel's one vertical scroller (scrolling back toward
	//     its top must stay native);
	//   • anything else (an upward drag) is native scrolling.
	// While one of the panel's own modals is up, the gesture is inert — a drag
	// on the sources list must not move the sheet behind it.
	//
	// These are raw non-passive listeners, not Svelte `ontouchmove` attributes —
	// Svelte registers touchmove passively, and a passive listener cannot
	// preventDefault the scroll.
	let menuEl = $state<HTMLElement | null>(null);
	// Per-gesture mode: undecided until the first touchmove, then fixed.
	let touchMode: 'idle' | 'sheet' | 'native' = 'idle';
	let touchStartY = 0;
	let touchStartX = 0;
	let touchInMenu = false;

	function onSheetTouchStart(event: TouchEvent) {
		if (!narrow || event.touches.length !== 1) return;
		touchMode = 'idle';
		touchStartY = event.touches[0].clientY;
		touchStartX = event.touches[0].clientX;
		touchInMenu = event.target instanceof Node && (menuEl?.contains(event.target) ?? false);
		lastTouchY = touchStartY;
		lastTouchT = event.timeStamp;
		dragVelocity = 0;
	}

	function onSheetTouchMove(event: TouchEvent) {
		if (!narrow || event.touches.length !== 1) return;
		if (touchMode === 'native') return; // committed to native scrolling
		const y = event.touches[0].clientY;
		if (touchMode === 'idle') {
			// Decide this gesture's mode from its first movement.
			const dy = y - touchStartY;
			const horizontal = Math.abs(event.touches[0].clientX - touchStartX) > Math.abs(dy);
			const scrolledMenu = touchInMenu && (menuEl?.scrollTop ?? 0) > 0;
			if (sourcesOpen || directionsOpen || horizontal || dy <= 0 || scrolledMenu) {
				touchMode = 'native';
				return;
			}
			touchMode = 'sheet';
			dragging = true;
			dragStartY = y;
			dragPanelHeight = el?.getBoundingClientRect().height ?? 0;
		}
		// Steal the gesture from native scrolling and track the finger 1:1.
		event.preventDefault();
		dragOffset = Math.min(dragPanelHeight, Math.max(0, y - dragStartY));
		const dt = event.timeStamp - lastTouchT;
		if (dt > 0) dragVelocity = (y - lastTouchY) / dt;
		lastTouchY = y;
		lastTouchT = event.timeStamp;
	}

	function onSheetTouchEnd() {
		const wasSheet = touchMode === 'sheet';
		touchMode = 'idle';
		if (!wasSheet) return;
		dragging = false;
		if (shouldDismissSheet(dragOffset ?? 0, dragVelocity, dragPanelHeight)) {
			// The drag offset is deliberately KEPT so the outro fly starts from
			// where the finger left the sheet, not from a snapped-back position
			// (the fly transition bakes the element's current transform into its
			// animation base).
			onClose();
			return;
		}
		// Spring back: drop the offset; the CSS transform transition eases the
		// sheet back up to resting.
		dragOffset = null;
	}

	$effect(() => {
		const sheet = el;
		if (!sheet || !narrow) return;
		sheet.addEventListener('touchstart', onSheetTouchStart, { passive: true });
		sheet.addEventListener('touchmove', onSheetTouchMove, { passive: false });
		sheet.addEventListener('touchend', onSheetTouchEnd);
		sheet.addEventListener('touchcancel', onSheetTouchEnd);
		return () => {
			sheet.removeEventListener('touchstart', onSheetTouchStart);
			sheet.removeEventListener('touchmove', onSheetTouchMove);
			sheet.removeEventListener('touchend', onSheetTouchEnd);
			sheet.removeEventListener('touchcancel', onSheetTouchEnd);
		};
	});
</script>

<aside
	class="placecard"
	class:placecard--dragging={dragging}
	aria-label={m.venue_details_aria()}
	tabindex="-1"
	bind:this={el}
	style:transform={dragOffset !== null ? `translateY(${dragOffset}px)` : undefined}
	transition:fly={flyParams}
>
	<button
		type="button"
		class="placecard__close"
		aria-label={m.venue_close_aria()}
		onclick={onClose}
	>
		✕
	</button>
	<header class="placecard__head">
		<!-- The venue name is the page's <h1>: when a venue is open the landing
		     overlay (which owns the site-level <h1>) is hidden, so a /locations/<id>
		     page would otherwise ship with no <h1>. The two are mutually exclusive
		     (landing renders only when nothing is selected), so exactly one <h1> is
		     ever on the page. -->
		<h1 class="placecard__name">{loc.name}</h1>
		{#if label}
			<span class="badge">{label}</span>
		{/if}
		{#if user}
			<span class="placecard__like">
				<LikeButton
					liked={likedLocationIds.has(loc.id)}
					onToggle={() => onToggleLocationLike(loc.id)}
					label={likedLocationIds.has(loc.id) ? m.venue_unlike() : m.venue_like()}
					size={18}
				/>
			</span>
		{/if}
	</header>

	<!-- Everything between the header and the footer scrolls as one column, so a
	     long menu (or a tall info block on the bottom sheet) never overflows the
	     panel. -->
	<div class="placecard__body">
		{#if loc.address || phone || loc.website || loc.opening_hours}
			<dl class="info">
				{#if loc.address}
					<!-- The address is the launch point for navigation (the #1 action after
					     finding a venue on a phone): tapping it opens the maps-app chooser,
					     which links the venue in Apple/Google Maps (see DirectionsModal). -->
					<div class="info__row">
						<dt>{m.venue_address_label()}</dt>
						<dd>
							<button
								type="button"
								class="info__directions"
								aria-haspopup="dialog"
								aria-label={m.directions_button_aria({ address: loc.address })}
								onclick={() => (directionsOpen = true)}
								use:tooltip={m.directions_button_tooltip()}
							>
								{loc.address}
							</button>
						</dd>
					</div>
				{/if}
				{#if phone}
					<div class="info__row">
						<dt>{m.venue_phone_label()}</dt>
						<dd>
							<a href="tel:{phone.tel}"
								>{phone.display}{#if phone.extension}
									{m.venue_phone_extension({ ext: phone.extension })}{/if}</a
							>
						</dd>
					</div>
				{/if}
				{#if loc.website}
					<!-- Website and source URLs come from world-editable feeds (OSM tags,
					     agent-cited sources), so an anchor is only rendered for an
					     http(s)-scheme URL; anything else shows as plain text. -->
					{@const websiteHref = safeHttpUrl(loc.website)}
					<div class="info__row">
						<dt>{m.venue_website_label()}</dt>
						<dd>
							{#if websiteHref}
								<a href={websiteHref} target="_blank" rel="external noopener noreferrer">
									{loc.website}
								</a>
							{:else}
								{loc.website}
							{/if}
						</dd>
					</div>
				{/if}
				{#if loc.opening_hours}
					<div class="info__row">
						<dt>{m.venue_hours_label()}</dt>
						<dd>
							{#if hoursRows}
								<!-- Grouped weekly table from the derived opening_hours_json;
								     day/time forms come from Intl for the active locale. -->
								<div class="hours">
									{#each hoursRows as row (row.days[0])}
										<div class="hours__row" class:hours__row--closed={row.spans.length === 0}>
											<span class="hours__days">{hoursDayLabel(row)}</span>
											<span class="hours__times">
												{row.spans.length ? hoursTimesLabel(row) : m.venue_hours_closed()}
											</span>
										</div>
									{/each}
								</div>
							{:else}
								<!-- Hours beyond the parsed OSM subset (seasonal/holiday grammar):
								     show the stored source string verbatim. -->
								{loc.opening_hours}
							{/if}
						</dd>
					</div>
				{/if}
			</dl>
		{/if}

		<!-- Menu header: the "Menu" label, a subtle item-count/freshness note, and —
		     when the venue cites provenance — a button opening the sources modal
		     (sources are menu-level now). Shown whenever there's a menu or sources
		     to head. -->
		{#if loc.menu.length > 0 || loc.sources.length > 0}
			<div class="placecard__menu-head">
				<h2 class="placecard__menu-title">{m.venue_menu_label()}</h2>
				{#if loc.menu.length > 0}
					{@const itemsLabel = m.menu_items_count({ count: loc.menu.length })}
					<span
						class="placecard__menu-meta"
						use:tooltip={loc.lastVerified
							? m.menu_last_scanned({ date: loc.lastVerified })
							: undefined}
					>
						{loc.lastVerified ? `${itemsLabel} · ${formatScanned(loc.lastVerified)}` : itemsLabel}
					</span>
				{/if}
				{#if loc.sources.length > 0}
					<button type="button" class="placecard__sources-btn" onclick={() => (sourcesOpen = true)}>
						{m.sources_count({ count: loc.sources.length })}
					</button>
				{/if}
			</div>
		{/if}

		<!-- Course filter: shown only when the menu actually spans more than one
		     course, so a single-category venue keeps a clean header. Replaces the
		     old per-item Dessert/Drink pills — the course now lives up here as a
		     browsing category instead of a per-row label. -->
		{#if courseOptions.length >= 2}
			<div class="coursebar" role="group" aria-label={m.course_filter_aria()}>
				<button
					type="button"
					class="coursebar__btn"
					aria-pressed={course === 'all'}
					onclick={(e) => selectCourse('all', e.currentTarget)}
				>
					{m.course_all()}
				</button>
				{#each courseOptions as option (option)}
					<button
						type="button"
						class="coursebar__btn"
						aria-pressed={course === option}
						onclick={(e) => selectCourse(option, e.currentTarget)}
					>
						{tagDisplayName(option)}
					</button>
				{/each}
			</div>
		{/if}

		<!-- The venue's full menu (narrowed by the course filter above). The map
		     labels only rotate a teaser item per venue, so this is where the whole
		     menu — each item's price, description and dietary markers — is read. -->
		{#if loc.menu.length > 0}
			<ul class="placecard__menu" bind:this={menuEl}>
				{#each visibleMenu as menuItem (menuItem.id)}
					<li class="placecard__item">
						<span class="placecard__item-line">
							<span class="placecard__item-main">
								<span class="placecard__item-name">{menuItem.item_name}</span>
								<DietaryIcons tags={menuItem.tags} />
							</span>
							{#if menuItem.price !== null}
								<span class="placecard__item-price">
									{formatPrice(menuItem.price, menuItem.currency)}
								</span>
							{/if}
							{#if user}
								<span class="placecard__item-like">
									<LikeButton
										liked={likedItemIds.has(menuItem.id)}
										onToggle={() => onToggleItemLike(menuItem.id)}
										label={likedItemIds.has(menuItem.id) ? m.item_unlike() : m.item_like()}
										size={14}
									/>
								</span>
							{/if}
						</span>
						{#if menuItem.description}
							<p class="placecard__item-desc">{menuItem.description}</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	{#if loc.menu.length === 0}
		<footer class="placecard__foot">
			<span class="placecard__hint">{m.venue_no_menu()}</span>
		</footer>
	{/if}

	<DirectionsModal
		latitude={loc.latitude}
		longitude={loc.longitude}
		name={loc.name}
		address={loc.address}
		bind:open={directionsOpen}
	/>
	<SourcesModal sources={loc.sources} bind:open={sourcesOpen} />
</aside>

<style>
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

	/* The panel takes programmatic focus on open (tabindex="-1"); it isn't
	   tab-reachable, so a focus ring on the whole panel is noise. */
	.placecard:focus {
		outline: none;
	}

	/* The middle of the panel (info block, menu header, course tabs, menu list),
	   between the fixed header and footer. The body itself does NOT scroll — the
	   info block and course tabs stay put, and the menu LIST below them is the
	   panel's one vertical scroll container (see .placecard__menu). min-height: 0
	   lets the column actually shrink inside the panel flex column; overflow
	   hidden clips anything a child fails to wrap or scroll itself, so no
	   scrollbar can appear at this level. */
	.placecard__body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
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

	/* Touch target: the ✕ stays visually 1.6rem, but on a coarse pointer a
	   transparent overlay grows the tappable area to the 44px floor. */
	@media (pointer: coarse) {
		.placecard__close::after {
			content: '';
			position: absolute;
			top: 50%;
			left: 50%;
			width: 44px;
			height: 44px;
			transform: translate(-50%, -50%);
		}
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

	/* The open venue's full menu: the panel's ONE vertical scroll container. The
	   info block and course tabs above it stay fixed while a long menu scrolls
	   under them. flex: 1 + min-height: 0 make it soak exactly the space the body
	   has left; overflow-x hidden because overflow-y: auto alone would compute
	   overflow-x to auto and let a poking child summon a horizontal scrollbar. */
	.placecard__menu {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		/* A scroll that hits the list's top hands the gesture to the sheet drag
		   (see the touch handlers) — never to the page or a rubber-band bounce. */
		overscroll-behavior-y: contain;
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

	/* Name + dietary icons, grouped so the icons sit directly to the right of the name
	   text. This group soaks the spare width (flex: 1) so the price (when the item has
	   one) and the like heart (when signed in) sit together at the row's right edge;
	   the icons wrap under the name only when the row is too narrow to hold them
	   inline. */
	.placecard__item-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		column-gap: 0.4rem;
		row-gap: 0.15rem;
	}

	.placecard__item-name {
		font-size: 0.85rem;
		font-weight: 600;
		/* A pathological unbroken name breaks mid-word rather than overflowing. */
		overflow-wrap: anywhere;
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
		overflow-wrap: anywhere;
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

	/* Weekly hours: one line per grouped day-run ("Mon–Fri  11:00 a.m.–10:00 p.m."),
	   day labels in a narrow lead column so the times align. Closed runs mute to
	   read as absence, not information. */
	.hours {
		display: grid;
		gap: 0.15rem;
	}

	.hours__row {
		display: grid;
		grid-template-columns: 4.5rem 1fr;
		gap: 0 0.5rem;
	}

	.hours__row--closed .hours__times {
		color: var(--color-text-muted);
	}

	/* The address renders as a link-styled button (opens the maps-app chooser). It
	   matches the phone/website anchors beside it — accent colour, underline on
	   hover — rather than looking like a form control: strip the button chrome and
	   let it wrap like the plain text it replaced. */
	.info__directions {
		display: inline;
		padding: 0;
		border: none;
		background: none;
		color: var(--color-accent);
		text-align: left;
		word-break: break-word;
	}

	.info__directions:hover {
		text-decoration: underline;
	}

	/* The Menu header row: the "Menu" label with its item-count/freshness note
	   sitting quietly beside it, and the sources button pushed to the trailing
	   edge. */
	.placecard__menu-head {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.placecard__menu-title {
		margin: 0;
		font-size: 0.95rem;
	}

	/* The subtle note beside the Menu header: "12 items · Scanned 3 days ago".
	   Allowed to wrap — nowrap here could push the row past a narrow panel. */
	.placecard__menu-meta {
		font-size: 0.72rem;
		color: var(--color-text-muted);
	}

	/* The "N Sources" button opening the sources modal: a quiet outlined pill that
	   reads as a control without competing with the menu items below it. */
	.placecard__sources-btn {
		position: relative;
		flex-shrink: 0;
		margin-left: auto;
		padding: 0.2rem 0.6rem;
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 8%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 30%, #fff);
		border-radius: 999px;
		cursor: pointer;
		transition:
			background-color 0.12s,
			border-color 0.12s;
	}

	.placecard__sources-btn:hover {
		background: color-mix(in srgb, var(--color-accent) 16%, #fff);
		border-color: color-mix(in srgb, var(--color-accent) 45%, #fff);
	}

	/* Touch target: the short pill (~24px tall) keeps its look, but a coarse pointer
	   gets a 44px-tall transparent overlay so the finger target clears the floor
	   vertically (its width already covers the label). */
	@media (pointer: coarse) {
		.placecard__sources-btn::after {
			content: '';
			position: absolute;
			top: 50%;
			left: 0;
			width: 100%;
			height: 44px;
			transform: translateY(-50%);
		}
	}

	/* The course filter row above the menu list, styled after the Google Maps menu
	   category strip: one non-wrapping row of quiet text tabs that scrolls
	   horizontally, the active tab filled as a soft pill. The scrollbar is hidden —
	   a tab clipped mid-word at the panel edge is the scroll affordance. Negative
	   margins bleed the row through the placecard's horizontal padding (so tabs
	   scroll off the panel edge, not to an inset stop), and matching padding
	   restores the resting alignment with the sections above/below. */
	.coursebar {
		display: flex;
		flex-wrap: nowrap;
		gap: 0.25rem;
		/* The row is a flex item of the .placecard__body column, and its
		   overflow-x drops its automatic minimum size to 0 — without this it is
		   the one child squashed to zero height whenever the menu overflows the
		   panel (i.e. on virtually every real venue). No negative-margin bleed
		   through the panel padding: inside the body's clip it can't paint wider
		   anyway — it only manufactured phantom horizontal scroll. */
		flex-shrink: 0;
		overflow-x: auto;
		scroll-behavior: smooth;
		scrollbar-width: none;
	}

	.coursebar::-webkit-scrollbar {
		display: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.coursebar {
			scroll-behavior: auto;
		}
	}

	.coursebar__btn {
		flex-shrink: 0;
		padding: 0.35rem 0.75rem;
		font-size: 0.8rem;
		font-weight: 600;
		white-space: nowrap;
		color: var(--color-text-muted);
		background: transparent;
		border: none;
		border-radius: 999px;
		cursor: pointer;
		transition:
			background-color 0.12s,
			color 0.12s;
	}

	.coursebar__btn:hover {
		color: var(--color-text);
		background: color-mix(in srgb, var(--color-text) 6%, transparent);
	}

	.coursebar__btn[aria-pressed='true'] {
		color: var(--color-accent-hover);
		background: color-mix(in srgb, var(--color-accent) 14%, #fff);
	}

	/* Touch target: the row is a scroll container now, so the old transparent
	   ::after overlay would be clipped by it (overflow-x: auto clips the cross
	   axis too). Instead the tabs themselves grow to the 44px floor on coarse
	   pointers — the whole strip gets taller, matching the roomy Google Maps
	   strip rather than the compact desktop row. */
	@media (pointer: coarse) {
		.coursebar__btn {
			min-height: 44px;
		}
	}

	/* On narrow screens the detail panel is a FULL-SCREEN sheet: it slides up over
	   the whole viewport when a venue opens, with no intermediate resting heights.
	   At rest it fills the .app container edge to edge (inset 0 — the exact box
	   the map occupies, so the fit can never drift from the real viewport the way
	   a JS-measured height does around mobile URL bars). A dismiss drag offsets it
	   with an inline translateY; the transform transition animates the spring-back
	   after a released drag and is suppressed while the finger is down
	   (.placecard--dragging). The safe-area top padding keeps the content clear of
	   the notch/status bar; the top corners round only while a drag has peeled the
	   sheet off the top edge. */
	@media (max-width: 48rem) {
		/* No bottom padding on the panel itself: the menu list is the last thing
		   in the column, and its scroll edge must BE the bottom of the screen so
		   items scroll through the screen edge rather than stopping at an inset
		   strip. The breathing room moves INSIDE the scroll container (below). */
		.placecard {
			left: 0;
			right: 0;
			width: auto;
			padding: calc(0.35rem + env(safe-area-inset-top)) 0.95rem 0;
			border-left: none;
			border-top: 1px solid rgba(255, 255, 255, 0.6);
			border-radius: 0;
			box-shadow: 0 -12px 34px rgba(0, 0, 0, 0.22);
			transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
		}

		.placecard--dragging {
			border-radius: 0.9rem 0.9rem 0 0;
		}

		/* Interior bottom padding on the menu list (the scroll container), so the
		   last item can scroll up clear of the home indicator / screen edge while
		   mid-list content still passes through the very bottom of the screen. */
		.placecard__menu {
			padding-bottom: calc(0.85rem + env(safe-area-inset-bottom));
		}

		/* The no-menu footer replaces the list as the panel's last content — give
		   it back the bottom inset the panel no longer carries. */
		.placecard__foot {
			padding-bottom: calc(0.85rem + env(safe-area-inset-bottom));
		}

		/* On a phone at arm's length the panel's smallest load-bearing text — item
		   descriptions, the item-count/freshness meta, the "no menu" hint — reads
		   below comfortable minimums at its desktop 0.72–0.78rem, so nudge it up to
		   the 0.85rem the item names/address already use (issue #259). Desktop keeps
		   the tighter sizes, where the panel is read up close. */
		.placecard__item-desc,
		.placecard__menu-meta,
		.placecard__hint {
			font-size: 0.85rem;
		}
	}

	/* While the finger is down the sheet follows it 1:1 — no height easing. */
	.placecard--dragging {
		transition: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.placecard {
			transition: none;
		}
	}
</style>
