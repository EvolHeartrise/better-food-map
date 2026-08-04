<script lang="ts">
	/**
	 * Status pill. Colour never carries the meaning alone — the label always
	 * spells out the state, so the badge still reads under CVD or in print.
	 */
	type Tone = 'good' | 'warn' | 'bad' | 'neutral';

	let { tone = 'neutral', label, title }: { tone?: Tone; label: string; title?: string } = $props();
</script>

<span class="badge {tone}" {title}>{label}</span>
