<script lang="ts">
	import { safeHttpUrl } from '$lib/safe-url';
	import { m } from '$lib/paraglide/messages';
	import type { Source } from '$lib/server/db';

	// A modal listing a venue's data sources, opened from the "N Sources" button
	// beside the Menu header. It owns nothing but its DOM: `open` is bindable so the
	// page can layer its own Escape handling under this one (Escape closes only the
	// topmost layer — see the page's onWindowKeydown). A native <dialog> in the top
	// layer gives the backdrop, focus trap and Escape-to-close for free.
	let {
		sources,
		open = $bindable(false)
	}: {
		sources: Source[];
		open?: boolean;
	} = $props();

	let dialog = $state<HTMLDialogElement | null>(null);

	// Drive the platform modal from `open`. showModal() puts the dialog in the top
	// layer above the map and detail panel; close() (Escape, backdrop, ✕) fires the
	// `close` event below, which syncs `open` back to false.
	$effect(() => {
		const el = dialog;
		if (!el) return;
		if (open && !el.open) el.showModal();
		else if (!open && el.open) el.close();
	});

	// A short, readable name for a source: its label, else the bare hostname. Mirrors
	// the page's own sourceText so the list reads the same as it did inline.
	function sourceText(source: Source): string {
		if (source.label) return source.label;
		try {
			return new URL(source.url).hostname.replace(/^www\./, '');
		} catch {
			return source.url;
		}
	}

	// A click outside the dialog box (on the backdrop) closes it. The dialog element
	// fills only the box, so a pointer landing beyond its bounds is a backdrop click.
	function onDialogClick(event: MouseEvent) {
		const el = dialog;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const outside =
			event.clientX < rect.left ||
			event.clientX > rect.right ||
			event.clientY < rect.top ||
			event.clientY > rect.bottom;
		if (outside) open = false;
	}
</script>

<dialog
	bind:this={dialog}
	class="sources-modal"
	aria-label={m.sources_dialog_aria()}
	onclose={() => (open = false)}
	onclick={onDialogClick}
>
	<div class="sources-modal__panel">
		<header class="sources-modal__head">
			<h2 class="sources-modal__title">{m.sources_title()}</h2>
			<button
				type="button"
				class="sources-modal__close"
				aria-label={m.sources_close_aria()}
				onclick={() => (open = false)}
			>
				✕
			</button>
		</header>

		<!-- Source URLs come from world-editable feeds (agent-cited sources), so an
		     anchor is only rendered for an http(s)-scheme URL; anything else shows as
		     plain text. -->
		<ul class="sources-modal__list">
			{#each sources as source (source.url)}
				{@const href = safeHttpUrl(source.url)}
				<li>
					{#if href}
						<a {href} target="_blank" rel="external noopener noreferrer">{sourceText(source)}</a>
					{:else}
						{sourceText(source)}
					{/if}
				</li>
			{/each}
		</ul>
	</div>
</dialog>

<style>
	/* The dialog element IS the box (native modal, so it lives in the top layer over
	   the map and detail panel regardless of z-index). Reset the UA centring margins
	   and place it in the viewport centre ourselves. */
	.sources-modal {
		margin: auto;
		width: min(24rem, calc(100vw - 2rem));
		max-height: min(70vh, 32rem);
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 0.9rem;
		background: rgba(255, 255, 255, 0.96);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
		color: var(--color-text);
		overflow: hidden;
	}

	.sources-modal::backdrop {
		background: rgba(0, 0, 0, 0.4);
		backdrop-filter: blur(2px);
		-webkit-backdrop-filter: blur(2px);
	}

	.sources-modal__panel {
		display: flex;
		flex-direction: column;
		max-height: inherit;
		padding: 0.85rem 0.95rem 1rem;
	}

	.sources-modal__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.6rem;
	}

	.sources-modal__title {
		margin: 0;
		font-size: 1rem;
	}

	.sources-modal__close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		padding: 0;
		flex-shrink: 0;
		font-size: 0.8rem;
		line-height: 1;
		color: var(--color-text-muted);
		background: rgba(0, 0, 0, 0.04);
		border: 1px solid rgba(0, 0, 0, 0.08);
		border-radius: 999px;
		cursor: pointer;
		transition:
			background-color 0.12s,
			color 0.12s;
	}

	.sources-modal__close:hover {
		color: var(--color-text);
		background: rgba(0, 0, 0, 0.09);
	}

	/* The list scrolls inside the fixed-height box when a venue cites many sources. */
	.sources-modal__list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		font-size: 0.85rem;
		word-break: break-word;
	}
</style>
