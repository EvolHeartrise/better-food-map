<script lang="ts">
	/**
	 * "This configuration is retired" marker.
	 *
	 * Wherever it appears, it means a verdict has been recorded against the
	 * configuration — NOT that the runs behind it are bad. Those runs are usually
	 * the evidence the verdict was made from, and they keep their scores.
	 *
	 * The reason travels in the tooltip because a bare "blacklisted" is the thing
	 * that rots into superstition: six months on, "why is terra@max out?" has to be
	 * answerable from the screen, not from a git archaeology session.
	 */
	import Badge from './Badge.svelte';
	import type { BlacklistInfo, BlacklistState } from '../lib/types';

	let {
		state,
		entries = [],
		compact = false
	}: { state: BlacklistState; entries?: BlacklistInfo[]; compact?: boolean } = $props();

	let title = $derived(
		entries.length === 0
			? 'This configuration has been ruled out and will not be re-tested.'
			: entries
					.map((entry) => `${entry.label} — ${entry.reason} (added ${entry.added})`)
					.join('\n\n')
	);
</script>

{#if state !== 'none'}
	<Badge
		tone="neutral"
		label={state === 'partial'
			? compact
				? '⊘ partly'
				: '⊘ some configs retired'
			: compact
				? '⊘'
				: '⊘ blacklisted'}
		{title}
	/>
{/if}
