<script lang="ts">
	import { fly, type FlyParams } from 'svelte/transition';
	import DietaryIcons from '$lib/components/DietaryIcons.svelte';
	import SourcesModal from '$lib/components/SourcesModal.svelte';
	import LikeButton from '$lib/components/LikeButton.svelte';
	import { categoryLabel } from '$lib/category';
	import { tagDisplayName } from '$lib/tags';
	import { safeHttpUrl } from '$lib/safe-url';
	import { formatPhone } from '$lib/phone';
	import { tooltip } from '$lib/tooltip';
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
	// `sourcesOpen` is bindable so the page can layer its window-level Escape
	// handling under the modal's (Escape closes only the topmost layer).
	let {
		location,
		user,
		likedLocationIds,
		likedItemIds,
		onToggleLocationLike,
		onToggleItemLike,
		onClose,
		flyParams,
		sourcesOpen = $bindable(false),
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
		sourcesOpen?: boolean;
		el?: HTMLElement | null;
	} = $props();

	const loc = $derived(location);
	const label = $derived(categoryLabel(loc.category));
	// Phone rendered on read: one consistent display + a fully-qualified tel: href,
	// regardless of how the source spelled the stored number (issue #241).
	const phone = $derived(formatPhone(loc.phone, loc.country));

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
	// The segmented pill row above the menu list: All / Food / Dessert / Drinks.
	// Buckets come from the required course tags — Food is ABSENCE-based (neither
	// dessert nor drink), so items from before the course-tag mandate (no course
	// tag at all) still land somewhere sensible while the backlog drains. An item
	// tagged both dessert and drink (a milkshake) appears under both. An OPTIONAL
	// course tag never buckets (writes reject those now; pre-mandate data has none).
	// Each course pill's label comes from the shared tagDisplayName ($lib/tags),
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
	// Only categories with items get a pill; the whole row disappears when the
	// menu is single-category (an all-food diner, an all-drinks tea shop).
	const courseOptions = $derived(
		(['food', 'dessert', 'drink'] as const).filter((c) => courseBuckets[c].length > 0)
	);

	// The selection is remembered per venue id (no effect needed): switching to
	// another venue reads as 'all' until a pill is clicked there.
	let pickedCourse = $state<CourseFilter>('all');
	let pickedForId = $state('');
	const course = $derived.by((): CourseFilter => {
		if (pickedForId !== loc.id || pickedCourse === 'all') return 'all';
		// Guard against a stale pick (menu changed under the same id).
		return courseBuckets[pickedCourse].length > 0 ? pickedCourse : 'all';
	});
	function selectCourse(c: CourseFilter) {
		pickedForId = loc.id;
		pickedCourse = c;
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
</script>

<aside
	class="placecard"
	aria-label={m.venue_details_aria()}
	tabindex="-1"
	bind:this={el}
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
		{#if loc.address || phone || loc.website}
			<dl class="info">
				{#if loc.address}
					<div class="info__row">
						<dt>{m.venue_address_label()}</dt>
						<dd>{loc.address}</dd>
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
					onclick={() => selectCourse('all')}
				>
					{m.course_all()}
				</button>
				{#each courseOptions as option (option)}
					<button
						type="button"
						class="coursebar__btn"
						aria-pressed={course === option}
						onclick={() => selectCourse(option)}
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
			<ul class="placecard__menu">
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

	/* The subtle note beside the Menu header: "12 items · Scanned 3 days ago". */
	.placecard__menu-meta {
		font-size: 0.72rem;
		color: var(--color-text-muted);
		white-space: nowrap;
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

	/* The course filter row above the menu list: quiet outlined pills matching the
	   sources button's visual family; the active pill fills with the accent like
	   the category badge. */
	.coursebar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.coursebar__btn {
		position: relative;
		padding: 0.2rem 0.65rem;
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 8%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 30%, #fff);
		border-radius: 999px;
		cursor: pointer;
		transition:
			background-color 0.12s,
			border-color 0.12s,
			color 0.12s;
	}

	.coursebar__btn:hover {
		background: color-mix(in srgb, var(--color-accent) 16%, #fff);
		border-color: color-mix(in srgb, var(--color-accent) 45%, #fff);
	}

	.coursebar__btn[aria-pressed='true'] {
		color: #fff;
		background: var(--color-accent);
		border-color: var(--color-accent);
	}

	/* Touch target: same trick as the sources pill — a 44px-tall transparent overlay
	   on coarse pointers, so each course pill clears the floor without the row
	   growing taller. Pills sit side by side in one row, so extending only the
	   height keeps neighbours' hit areas from overlapping. */
	@media (pointer: coarse) {
		.coursebar__btn::after {
			content: '';
			position: absolute;
			top: 50%;
			left: 0;
			width: 100%;
			height: 44px;
			transform: translateY(-50%);
		}
	}

	/* On narrow screens the detail panel becomes a bottom sheet: the map keeps the
	   top of the screen (and centres the venue there via the matching bottom
	   camera inset), the details slide up from below. Height mirrors
	   SHEET_HEIGHT_PX, capped so a short landscape screen keeps some map. */
	@media (max-width: 48rem) {
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
</style>
