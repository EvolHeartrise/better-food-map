<script lang="ts">
	import Utensils from '@lucide/svelte/icons/utensils';
	import { DIET_OPTIONS } from '$lib/diet-profile';

	// The dietary selector: a single floating pill that filters the map to items a
	// source has marked with ONE chosen diet (vegan, gluten-free, halal, …), or to
	// everything when none is chosen. It replaces the old include/exclude tag
	// pickers — diet is the only filter now, and it is single-select.
	//
	// Controlled by the parent: `value` is the current selection (a dietary tag id
	// or null), and `onSelect` is called with the new value when the user picks one.
	// The parent both applies the filter and persists the choice (the selector IS the
	// saved profile), so this component owns only its open/closed state.
	let { value, onSelect }: { value: string | null; onSelect: (id: string | null) => void } =
		$props();

	let open = $state(false);

	const selectedLabel = $derived(DIET_OPTIONS.find((option) => option.id === value)?.label ?? null);

	function choose(id: string | null): void {
		onSelect(id);
		open = false;
	}

	// Escape closes the dropdown from anywhere (the trigger or an option may hold
	// focus); a pointerdown outside the control closes it too. Both are handled on the
	// window — mirroring AccountMenu — so the wrapper stays a plain, role-free element
	// and there's no open/close state churned from an $effect.
	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && open) {
			event.preventDefault();
			open = false;
		}
	}

	function onWindowPointerDown(event: PointerEvent): void {
		if (!open) return;
		if (!(event.target as HTMLElement | null)?.closest('.diet')) open = false;
	}
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onWindowPointerDown} />

<div class="diet">
	<button
		type="button"
		class="diet__trigger"
		class:diet__trigger--active={value !== null}
		aria-haspopup="menu"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<Utensils class="diet__icon" size={16} aria-hidden="true" />
		<span class="diet__label">{selectedLabel ?? 'Any diet'}</span>
		<span class="diet__chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
	</button>

	{#if open}
		<!-- A single-select menu: each option is a `menuitemradio` whose `aria-checked`
		     marks the current diet — so the option role lives on the button itself, not
		     on a wrapper around it. -->
		<ul class="menu" role="menu" aria-label="Dietary filter">
			<li role="none">
				<button
					type="button"
					role="menuitemradio"
					aria-checked={value === null}
					class="menu__option"
					class:menu__option--selected={value === null}
					onclick={() => choose(null)}
				>
					Any diet
				</button>
			</li>
			{#each DIET_OPTIONS as option (option.id)}
				<li role="none">
					<button
						type="button"
						role="menuitemradio"
						aria-checked={value === option.id}
						class="menu__option"
						class:menu__option--selected={value === option.id}
						onclick={() => choose(option.id)}
					>
						{option.label}
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

	.diet__trigger--active {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 12%, rgba(255, 255, 255, 0.85));
		border-color: color-mix(in srgb, var(--color-accent) 35%, #fff);
	}

	/* The leading icon renders inside the Lucide child's <svg>, so it's reached with
	   a scoped :global descendant rule; currentColor drives its stroke. */
	.diet__trigger :global(.diet__icon) {
		flex-shrink: 0;
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
		display: block;
		width: 100%;
		padding: 0.4rem 0.6rem;
		font: inherit;
		font-size: 0.88rem;
		text-align: left;
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

	/* The current selection: accent-tinted so it stands out in the list. */
	.menu__option--selected {
		font-weight: 600;
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 12%, #fff);
	}

	@media (max-width: 48rem) {
		.diet__trigger {
			font-size: 1rem;
		}
	}
</style>
