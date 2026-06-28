<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { getDietProfile, setDietProfile } from '$lib/profile.remote';
	import { DIETARY_RESTRICTIONS, ALLERGENS } from '$lib/diet-profile';

	// The dietary-profile editor: a modal dialog (opened from the account menu) where
	// a signed-in user picks the restrictions and allergies the map should pre-apply
	// as default filters. It owns only the in-progress selections; saving persists
	// them and refreshes the applied filters (see profile.remote), then closes.
	let { onClose }: { onClose: () => void } = $props();

	// Local, editable copy of the selections — stable catalog keys. Seeded once from
	// the saved profile when it loads (read via `.current` so the dialog renders
	// immediately rather than suspending). The dialog remounts on each open, so this
	// always starts from the latest saved profile.
	const savedResource = getDietProfile();
	const restrictions = new SvelteSet<string>();
	const allergies = new SvelteSet<string>();
	let seeded = false;
	$effect(() => {
		if (seeded) return;
		const saved = savedResource.current;
		if (!saved) return;
		for (const key of saved.restrictions) restrictions.add(key);
		for (const key of saved.allergies) allergies.add(key);
		seeded = true;
	});

	let saving = $state(false);

	function toggle(set: SvelteSet<string>, key: string): void {
		if (set.has(key)) set.delete(key);
		else set.add(key);
	}

	function clearAll(): void {
		restrictions.clear();
		allergies.clear();
	}

	async function save(): Promise<void> {
		saving = true;
		try {
			await setDietProfile({ restrictions: [...restrictions], allergies: [...allergies] });
			onClose();
		} catch {
			// Surface failure by staying open; the command throws 401 if the session
			// lapsed mid-edit. Re-enable the button so the user can retry.
			saving = false;
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="overlay">
	<button
		type="button"
		class="overlay__backdrop"
		aria-label="Close dietary profile"
		onclick={onClose}
	></button>

	<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="diet-profile-title">
		<header class="dialog__head">
			<h2 class="dialog__title" id="diet-profile-title">Dietary profile</h2>
			<button type="button" class="dialog__close" aria-label="Close" onclick={onClose}>✕</button>
		</header>

		<p class="dialog__intro">
			Pick your dietary restrictions and allergies. We’ll apply them as default filters whenever you
			use the map — you can always remove a filter for a one-off search.
		</p>

		<div class="dialog__body">
			<fieldset class="group">
				<legend class="group__legend">Dietary restrictions</legend>
				<p class="group__hint">Shows only items a source has marked with this designation.</p>
				<ul class="options">
					{#each DIETARY_RESTRICTIONS as option (option.key)}
						<li>
							<label class="option">
								<input
									type="checkbox"
									checked={restrictions.has(option.key)}
									onchange={() => toggle(restrictions, option.key)}
								/>
								<span>{option.label}</span>
							</label>
						</li>
					{/each}
				</ul>
			</fieldset>

			<fieldset class="group">
				<legend class="group__legend">Allergies &amp; intolerances</legend>
				<p class="group__hint">
					Hides items whose listed ingredients name the allergen (and, where we have one, requires
					the matching “-free” label).
				</p>
				<ul class="options">
					{#each ALLERGENS as option (option.key)}
						<li>
							<label class="option">
								<input
									type="checkbox"
									checked={allergies.has(option.key)}
									onchange={() => toggle(allergies, option.key)}
								/>
								<span>{option.label}</span>
							</label>
						</li>
					{/each}
				</ul>
			</fieldset>

			<p class="dialog__caveat" role="note">
				Filtering is best-effort and based on the data we have — a missing ingredient isn’t proof an
				item is free of an allergen. Always confirm with the venue if you have a severe allergy.
			</p>
		</div>

		<footer class="dialog__foot">
			<button type="button" class="btn btn--ghost" onclick={clearAll}>Clear all</button>
			<div class="dialog__foot-right">
				<button type="button" class="btn btn--ghost" onclick={onClose}>Cancel</button>
				<button type="button" class="btn btn--primary" onclick={save} disabled={saving}>
					{saving ? 'Saving…' : 'Save profile'}
				</button>
			</div>
		</footer>
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
	}

	/* Full-screen dismiss target behind the dialog; a real <button> so a click OR a
	   keyboard activation closes, keeping the backdrop accessible. */
	.overlay__backdrop {
		position: absolute;
		inset: 0;
		border: none;
		padding: 0;
		background: rgba(0, 0, 0, 0.4);
		cursor: default;
	}

	.dialog {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		width: min(30rem, 100%);
		max-height: min(40rem, calc(100dvh - 2rem));
		border-radius: 1rem;
		background: rgba(255, 255, 255, 0.96);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 16px 50px rgba(0, 0, 0, 0.28);
	}

	.dialog__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 1rem 1.1rem 0.5rem;
	}

	.dialog__title {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 700;
		color: var(--color-text);
	}

	.dialog__close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.8rem;
		height: 1.8rem;
		padding: 0;
		font-size: 0.9rem;
		line-height: 1;
		color: var(--color-text-muted);
		background: rgba(0, 0, 0, 0.05);
		border: none;
		border-radius: 999px;
		cursor: pointer;
	}

	.dialog__close:hover {
		background: rgba(0, 0, 0, 0.1);
		color: var(--color-text);
	}

	.dialog__intro {
		margin: 0;
		padding: 0 1.1rem;
		font-size: 0.85rem;
		color: var(--color-text-muted);
	}

	.dialog__body {
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		padding: 1rem 1.1rem;
		overflow-y: auto;
	}

	.group {
		margin: 0;
		padding: 0;
		border: none;
	}

	.group__legend {
		padding: 0;
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--color-text);
	}

	.group__hint {
		margin: 0.2rem 0 0.6rem;
		font-size: 0.78rem;
		color: var(--color-text-muted);
	}

	.options {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: 0.4rem 0.8rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.option {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.4rem;
		border-radius: 0.5rem;
		font-size: 0.88rem;
		color: var(--color-text);
		cursor: pointer;
	}

	.option:hover {
		background: rgba(0, 0, 0, 0.04);
	}

	.option input {
		width: 1rem;
		height: 1rem;
		accent-color: var(--color-accent);
		cursor: pointer;
	}

	.dialog__caveat {
		margin: 0;
		padding: 0.65rem 0.75rem;
		font-size: 0.78rem;
		line-height: 1.4;
		color: var(--color-text-muted);
		background: rgba(0, 0, 0, 0.04);
		border-radius: 0.6rem;
	}

	.dialog__foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.75rem 1.1rem 1rem;
		border-top: 1px solid rgba(0, 0, 0, 0.08);
	}

	.dialog__foot-right {
		display: flex;
		gap: 0.5rem;
	}

	.btn {
		padding: 0.5rem 0.9rem;
		font: inherit;
		font-size: 0.85rem;
		font-weight: 600;
		border-radius: 0.6rem;
		border: 1px solid transparent;
		cursor: pointer;
	}

	.btn--primary {
		color: #fff;
		background: var(--color-accent);
	}

	.btn--primary:hover {
		filter: brightness(0.95);
	}

	.btn--primary:disabled {
		opacity: 0.6;
		cursor: progress;
	}

	.btn--ghost {
		color: var(--color-text);
		background: transparent;
		border-color: rgba(0, 0, 0, 0.15);
	}

	.btn--ghost:hover {
		background: rgba(0, 0, 0, 0.05);
	}
</style>
