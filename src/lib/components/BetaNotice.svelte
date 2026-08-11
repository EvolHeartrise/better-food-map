<script lang="ts">
	import { browser } from '$app/environment';
	import { m } from '$lib/paraglide/messages';
	import Modal from './Modal.svelte';

	// A once-per-visit notice over the front-page landing: BetterFoodMaps is in
	// active development and the beta covers Canada only. The shared Modal owns the
	// dialog shell (backdrop, focus trap, Escape-to-close, header/✕); this component
	// supplies the copy, an opt-out checkbox and the dismiss button. A plain dismissal
	// (✕, Escape, backdrop, "Got it") shows the notice again on the next visit; only
	// the checkbox suppresses it for good.
	const STORAGE_KEY = 'betaNotice.dismissed';

	// Whether a previous visit opted out. localStorage doesn't exist during SSR
	// (the `browser` guard) and can throw when storage is disabled (private modes)
	// — the notice still shows then, the opt-out just can't stick.
	function previouslyDismissed(): boolean {
		if (!browser) return false;
		try {
			return localStorage.getItem(STORAGE_KEY) !== null;
		} catch {
			return false;
		}
	}

	// Decided once at client init: SSR renders the dialog closed, and the client
	// re-runs this initializer at hydration with localStorage available.
	let open = $state(!previouslyDismissed());
	let dontShowAgain = $state(false);

	// Persist the opt-out the moment the box is toggled, so every dismissal path —
	// ✕, Escape, backdrop and the button — honours it without close-time bookkeeping.
	function persistChoice(): void {
		try {
			if (dontShowAgain) localStorage.setItem(STORAGE_KEY, '1');
			else localStorage.removeItem(STORAGE_KEY);
		} catch {
			// Storage unavailable — the dismissal lasts this visit only.
		}
	}
</script>

<Modal
	bind:open
	title={m.beta_notice_title()}
	ariaLabel={m.beta_notice_dialog_aria()}
	closeLabel={m.beta_notice_close_aria()}
>
	<p class="beta-notice__body">{m.beta_notice_body()}</p>

	<label class="beta-notice__optout">
		<input type="checkbox" bind:checked={dontShowAgain} onchange={persistChoice} />
		{m.beta_notice_dont_show()}
	</label>

	<button type="button" class="beta-notice__ok" onclick={() => (open = false)}>
		{m.beta_notice_ok()}
	</button>
</Modal>

<style>
	.beta-notice__body {
		margin: 0 0 0.85rem;
		font-size: 0.9rem;
		line-height: 1.5;
	}

	.beta-notice__optout {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin-bottom: 0.85rem;
		font-size: 0.85rem;
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.beta-notice__optout input {
		margin: 0;
		accent-color: var(--color-accent);
	}

	/* Same accent-filled primary treatment as the landing CTA, sized for a dialog. */
	.beta-notice__ok {
		align-self: flex-end;
		padding: 0.5rem 1.1rem;
		border: none;
		border-radius: 0.7rem;
		background: var(--color-accent);
		color: #fff;
		font: inherit;
		font-size: 0.9rem;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 0.12s;
	}

	.beta-notice__ok:hover {
		background: var(--color-accent-hover);
	}

	.beta-notice__ok:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
</style>
