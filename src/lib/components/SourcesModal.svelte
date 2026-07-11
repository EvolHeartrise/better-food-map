<script lang="ts">
	import { safeHttpUrl } from '$lib/safe-url';
	import { m } from '$lib/paraglide/messages';
	import Modal from './Modal.svelte';
	import type { Source } from '$lib/server/db';

	// A modal listing a venue's data sources, opened from the "N Sources" button
	// beside the Menu header. The shared Modal owns the dialog shell (backdrop, focus
	// trap, Escape-to-close, header/✕); this component supplies the sources list.
	// `open` is bindable so the page can layer its own Escape handling under this one.
	let {
		sources,
		open = $bindable(false)
	}: {
		sources: Source[];
		open?: boolean;
	} = $props();

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
</script>

<Modal
	bind:open
	title={m.sources_title()}
	ariaLabel={m.sources_dialog_aria()}
	closeLabel={m.sources_close_aria()}
	width="min(24rem, calc(100vw - 2rem))"
	maxHeight="min(70vh, 32rem)"
>
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
</Modal>

<style>
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
