<script lang="ts">
	import { tick } from 'svelte';
	import Utensils from '@lucide/svelte/icons/utensils';
	import { DIET_OPTIONS } from '$lib/diet-profile';
	import { dietIcon } from '$lib/dietary-icons';
	import { tagDisplayName } from '$lib/tags';
	import { createPopoverDismiss } from '$lib/popover-dismiss';
	import { m } from '$lib/paraglide/messages';

	// The dietary selector: a single floating pill that filters the map to items a
	// source has marked with ONE chosen diet (vegan, gluten-friendly, halal, …), or to
	// everything when none is chosen. Diet is the map's only menu filter, and it
	// is single-select.
	//
	// Controlled by the parent: `value` is the current selection (a dietary tag id
	// or null), and `onSelect` is called with the new value when the user picks one.
	// The parent both applies the filter and persists the choice (the selector IS the
	// saved profile), so this component owns only its open/closed state.
	let { value, onSelect }: { value: string | null; onSelect: (id: string | null) => void } =
		$props();

	let open = $state(false);
	let rootEl: HTMLDivElement;
	let triggerEl: HTMLButtonElement;
	let menuEl = $state<HTMLUListElement>();

	// The chosen diet's localized display name, or null when nothing (or an
	// unknown id) is selected — the label is resolved through the shared tag
	// display helper ($lib/tags) so it reads identically to the dietary marks.
	const selectedLabel = $derived(
		value !== null && DIET_OPTIONS.some((option) => option.id === value)
			? tagDisplayName(value)
			: null
	);

	// The tone color for a diet: green for vegan/vegetarian/halal, orange for the
	// "-free" tags, or undefined ("inherit the default") for "Any diet". Returned as a
	// CSS color so ONE inline style:color drives both the icon (via currentColor) and
	// the label text — keeping the two the same color everywhere the diet is shown.
	function toneColor(id: string | null): string | undefined {
		const tone = id !== null ? dietIcon(id)?.tone : undefined;
		if (tone === 'green') return 'var(--color-accent)';
		if (tone === 'orange') return 'var(--color-caution)';
		return undefined;
	}

	// The dropdown is a real ARIA menu (menuitemradio options), so it owes the menu
	// keyboard contract: focus moves into the list on open, ArrowUp/Down wrap through
	// the options (Home/End jump), Tab closes, and Escape closes AND hands focus back
	// to the trigger. Options are focused directly (all tabindex="-1") rather than via
	// a roving tabindex, so the list contributes nothing to the page's Tab order.
	function menuItems(): HTMLButtonElement[] {
		return menuEl ? [...menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')] : [];
	}

	async function openMenu(focusTarget: 'checked' | 'first' | 'last'): Promise<void> {
		open = true;
		await tick();
		const items = menuItems();
		const target =
			focusTarget === 'last'
				? items.at(-1)
				: focusTarget === 'checked'
					? (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])
					: items[0];
		target?.focus();
	}

	function choose(id: string | null): void {
		onSelect(id);
		open = false;
		triggerEl.focus();
	}

	function onTriggerClick(): void {
		if (open) open = false;
		else void openMenu('checked');
	}

	// Per the menu-button pattern, the closed trigger also opens on ArrowDown (focus
	// first option) and ArrowUp (focus last).
	function onTriggerKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			void openMenu(event.key === 'ArrowDown' ? 'first' : 'last');
		}
	}

	function onMenuKeydown(event: KeyboardEvent): void {
		if (event.key === 'Tab') {
			// Tab leaves the widget: close and let focus move on naturally.
			open = false;
			return;
		}
		const items = menuItems();
		const index = items.indexOf(document.activeElement as HTMLButtonElement);
		let target: HTMLButtonElement | undefined;
		if (event.key === 'ArrowDown') target = items[(index + 1) % items.length];
		else if (event.key === 'ArrowUp') target = items.at(index <= 0 ? -1 : index - 1);
		else if (event.key === 'Home') target = items[0];
		else if (event.key === 'End') target = items.at(-1);
		else return;
		event.preventDefault();
		target?.focus();
	}

	// Escape closes the dropdown from anywhere and a pointerdown outside it closes it too,
	// with focus returned to the trigger — shared with AccountMenu.
	const dismiss = createPopoverDismiss({
		isOpen: () => open,
		close: () => (open = false),
		getRoot: () => rootEl,
		getTrigger: () => triggerEl
	});
</script>

<svelte:window onkeydown={dismiss.onWindowKeydown} onpointerdown={dismiss.onWindowPointerDown} />

<!-- The leading glyph for a diet id (or the neutral knife-and-fork for "Any diet",
     id null), shared by the trigger and every dropdown option. It carries no color of
     its own — currentColor, set by the button's inline style:color, tints it. -->
{#snippet dietGlyph(id: string | null, size: number)}
	{@const spec = id !== null ? dietIcon(id) : undefined}
	<span class="diet__icon" aria-hidden="true">
		{#if spec}
			{@const Icon = spec.icon}
			<Icon {size} />
		{:else}
			<Utensils {size} />
		{/if}
	</span>
{/snippet}

<div class="diet" bind:this={rootEl}>
	<button
		type="button"
		class="diet__trigger"
		class:diet__trigger--active={value !== null}
		style:color={toneColor(value)}
		aria-label={`${m.diet_filter_aria()}: ${selectedLabel ?? m.diet_any()}`}
		aria-haspopup="menu"
		aria-expanded={open}
		bind:this={triggerEl}
		onclick={onTriggerClick}
		onkeydown={onTriggerKeydown}
	>
		{@render dietGlyph(value, 16)}
		<span class="diet__label">{selectedLabel ?? m.diet_any()}</span>
		<span class="diet__chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
	</button>

	{#if open}
		<!-- A single-select menu: each option is a `menuitemradio` whose `aria-checked`
		     marks the current diet — so the option role lives on the button itself, not
		     on a wrapper around it. -->
		<ul
			class="menu"
			role="menu"
			aria-label={m.diet_filter_aria()}
			bind:this={menuEl}
			onkeydown={onMenuKeydown}
		>
			<li role="none">
				<button
					type="button"
					role="menuitemradio"
					aria-checked={value === null}
					tabindex="-1"
					class="menu__option"
					class:menu__option--selected={value === null}
					onclick={() => choose(null)}
				>
					{@render dietGlyph(null, 16)}
					{m.diet_any()}
				</button>
			</li>
			{#each DIET_OPTIONS as option (option.id)}
				<li role="none">
					<button
						type="button"
						role="menuitemradio"
						aria-checked={value === option.id}
						tabindex="-1"
						class="menu__option"
						class:menu__option--selected={value === option.id}
						style:color={toneColor(option.id)}
						onclick={() => choose(option.id)}
					>
						{@render dietGlyph(option.id, 16)}
						{tagDisplayName(option.id)}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.diet {
		position: relative;
	}

	/* The trigger pill: matches the plain search pills (Place / Item) so every
	   floating control reads as one family. Goes accent-tinted once a diet is set,
	   so an active filter is obvious at a glance. */
	.diet__trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		height: var(--control-height);
		padding: 0.4rem 0.7rem;
		font: inherit;
		font-size: 0.9rem;
		color: var(--color-text);
		cursor: pointer;
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.72);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
	}

	.diet__trigger:focus-visible {
		outline: none;
		border-color: var(--color-accent);
	}

	/* Active pill: the color comes from the inline style:color (the diet's tone), and
	   currentColor tints the fill/border to match, so an orange diet gets an orange
	   pill and a green diet a green one — never a tone/tint mismatch. The fill is only
	   a whisper of tone over near-opaque white (kept close to white on purpose); the
	   border carries most of the tone so the active state still reads. */
	.diet__trigger--active {
		background: color-mix(in srgb, currentColor 5%, rgba(255, 255, 255, 0.92));
		border-color: color-mix(in srgb, currentColor 30%, #fff);
	}

	/* The leading glyph wrapper (a <span> around the icon). It lays the SVG out and
	   holds no color of its own: currentColor — set by the button's inline style:color —
	   drives the child <svg>'s stroke/fill so the icon always matches the label text. */
	.diet__icon {
		display: inline-flex;
		flex-shrink: 0;
		line-height: 0;
	}

	.diet__chevron {
		font-size: 0.7rem;
		line-height: 1;
		color: var(--color-text-muted);
	}

	/* The dropdown list, anchored under the trigger and floated over the map. Uses
	   the same frosted-glass recipe as the pill it drops from. */
	.menu {
		position: absolute;
		z-index: 30;
		top: calc(100% + 0.3rem);
		left: 0;
		min-width: 100%;
		margin: 0;
		padding: 0.3rem;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.92);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
	}

	.menu__option {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.4rem 0.6rem;
		font: inherit;
		font-size: 0.88rem;
		white-space: nowrap;
		color: var(--color-text);
		background: none;
		border: none;
		border-radius: 0.45rem;
		cursor: pointer;
	}

	.menu__option:hover,
	.menu__option:focus-visible {
		outline: none;
		background: rgba(0, 0, 0, 0.06);
	}

	/* Touch targets: the options are a stacked list, so grow each row to the 44px
	   floor on coarse pointers (a genuine min-height, not an overlay, keeps adjacent
	   rows' hit areas from overlapping). The dropdown floats over the map, so the
	   extra height pushes nothing. */
	@media (pointer: coarse) {
		.menu__option {
			min-height: 44px;
		}
	}

	/* The current selection: bold, with a tint of its OWN tone (currentColor is the
	   option's inline tone color) so the highlight matches the option's text/icon. */
	.menu__option--selected {
		font-weight: 600;
		background: color-mix(in srgb, currentColor 15%, transparent);
	}

	@media (max-width: 48rem) {
		.diet__trigger {
			font-size: 1rem;
		}

		/* On narrow screens the search row (and this selector with it) floats at the
		   BOTTOM of the screen, so a downward dropdown would spill off-screen. Open it
		   upward instead, anchored to the trigger's top edge. */
		.menu {
			top: auto;
			bottom: calc(100% + 0.3rem);
		}
	}
</style>
