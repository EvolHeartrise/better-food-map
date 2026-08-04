<script lang="ts">
	/**
	 * Stat tile: label · value · optional note. Proportional figures on the value
	 * (tabular-nums makes a big standalone number look loose); the note carries
	 * the caveat that stops the number being read as more than it is.
	 */
	let {
		label,
		value,
		note,
		tone = 'plain'
	}: {
		label: string;
		value: string;
		note?: string;
		tone?: 'plain' | 'warn' | 'bad';
	} = $props();
</script>

<div class="tile">
	<div class="label">{label}</div>
	<div class="value" class:warn={tone === 'warn'} class:bad={tone === 'bad'}>{value}</div>
	{#if note}<div class="note">{note}</div>{/if}
</div>

<style>
	.tile {
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 12px 14px;
		min-width: 0;
	}

	.label {
		color: var(--text-secondary);
		font-size: 12px;
	}

	.value {
		font-size: 24px;
		font-weight: 600;
		letter-spacing: -0.02em;
		line-height: 1.2;
		margin-top: 2px;
	}

	.value.warn {
		color: var(--serious);
	}

	.value.bad {
		color: var(--critical);
	}

	.note {
		color: var(--text-muted);
		font-size: 11px;
		margin-top: 2px;
	}
</style>
