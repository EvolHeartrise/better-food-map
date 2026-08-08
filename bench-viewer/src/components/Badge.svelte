<script lang="ts">
	/**
	 * Status pill over the shadcn badge. Colour never carries the meaning alone —
	 * the label always spells out the state, so the badge still reads under CVD
	 * or in print.
	 */
	import { Badge as UiBadge } from '$lib/components/ui/badge';

	type Tone = 'good' | 'warn' | 'bad' | 'neutral';

	const TONE_CLASS: Record<Tone, string> = {
		good: 'border-good/40 bg-good/10 text-good',
		warn: 'border-serious/45 bg-serious/12 text-serious',
		bad: 'border-critical/45 bg-critical/12 text-critical',
		neutral: 'border-border bg-transparent text-muted-foreground'
	};

	let { tone = 'neutral', label, title }: { tone?: Tone; label: string; title?: string } = $props();
</script>

<UiBadge variant="outline" class={TONE_CLASS[tone]} {title}>{label}</UiBadge>
