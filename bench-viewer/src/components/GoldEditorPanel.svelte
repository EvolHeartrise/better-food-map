<script lang="ts">
	/**
	 * Gold editor panel — bench:review's two-pane UI, consolidated into the
	 * viewer. LEFT: each crawled page as readable text, menu-shaped pages first;
	 * focusing an item highlights and scrolls to its name. RIGHT: the editable
	 * item list. An item whose name appears NOWHERE in the snapshot gets the
	 * loud NO HITS badge — the draft's main failure mode is rewritten names, and
	 * the core loop is editing the name until the badge clears.
	 *
	 * Writes go through /api/authoring/save (gold files + review state — bench
	 * INPUTS; run evidence is untouchable from this app). Saving is debounced
	 * autosave, same as bench:review. Local `$state` is initialised from props
	 * once per mount; the parent remounts this component per task via `#key`.
	 */
	import { promoteGold, saveGold } from '../lib/api';
	import { router } from '../lib/state.svelte';
	import type { AuthoringTask, GoldItem } from '../lib/types';
	import Chip from './Chip.svelte';
	import { Badge as UiBadge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';

	const DIETARY = [
		'vegan',
		'vegetarian',
		'gluten_free',
		'dairy_free',
		'nut_free',
		'halal'
	] as const;

	let { data, pageTexts }: { data: AuthoringTask; pageTexts: Record<string, string> } = $props();

	// Initial-value capture is the point: the editor owns these mutably from
	// here on, and the parent remounts this component (#key) per task/file, so
	// the props can never change under a live instance.
	// svelte-ignore state_referenced_locally
	let items = $state(structuredClone(data.items));
	// svelte-ignore state_referenced_locally
	let sourcesText = $state(data.sources.join('\n'));
	// svelte-ignore state_referenced_locally
	let reviewed = $state([...data.reviewed]);
	// svelte-ignore state_referenced_locally
	let policyVersion = $state(
		data.policy_version === 'draft' ? new Date().toISOString().slice(0, 10) : data.policy_version
	);
	let activeTab = $state(0);
	let highlightName = $state<string | null>(null);
	let saveState = $state<'loaded' | 'dirty' | 'saving' | 'saved' | 'failed'>('loaded');
	let saveError = $state('');
	let promoteOut = $state<{ ok: boolean; text: string } | null>(null);

	// --- hit matching (mirror of lint.ts normalize + stripVariantSuffix) ---------

	const norm = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

	let pageNorms = $derived(
		Object.fromEntries(Object.entries(pageTexts).map(([url, text]) => [url, norm(text)]))
	);

	function stripVariant(name: string): string | null {
		const base = name.replace(/\s*\([^()]*\)$/, '');
		return base.length > 0 && base !== name ? base : null;
	}

	/** First page whose text contains the name (or its variant base), else -1. */
	function pageOf(name: string): number {
		const needle = norm(name);
		if (!needle) return -1;
		const base = stripVariant(name);
		const baseNeedle = base ? norm(base) : null;
		for (let i = 0; i < data.pages.length; i++) {
			const text = pageNorms[data.pages[i].url] ?? '';
			if (text.includes(needle) || (baseNeedle && text.includes(baseNeedle))) return i;
		}
		return -1;
	}

	let zeroCount = $derived(items.filter((item) => pageOf(item.name) < 0).length);
	let reviewedCount = $derived(items.filter((item) => reviewed.includes(item.name)).length);

	// --- left pane rendering ------------------------------------------------------

	const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	/** Plain-text segments; marked ones render as real <mark> elements (no @html). */
	interface Segment {
		text: string;
		mark: boolean;
		first: boolean;
	}

	function markInto(raw: string, needle: string): Segment[] | null {
		const trimmed = needle.trim();
		if (!trimmed) return null;
		const re = new RegExp(escapeRe(trimmed).replace(/(?:\\?\s)+/g, '\\s+'), 'gi');
		const segments: Segment[] = [];
		let cursor = 0;
		let first = true;
		for (const match of raw.matchAll(re)) {
			if (match.index > cursor) {
				segments.push({ text: raw.slice(cursor, match.index), mark: false, first: false });
			}
			segments.push({ text: match[0], mark: true, first });
			first = false;
			cursor = match.index + match[0].length;
		}
		if (first) return null; // no matches
		if (cursor < raw.length) segments.push({ text: raw.slice(cursor), mark: false, first: false });
		return segments;
	}

	/** Page text with the highlighted name marked; a single plain segment otherwise. */
	let pageSegments = $derived.by<Segment[]>(() => {
		if (data.pages.length === 0) return [];
		const raw = pageTexts[data.pages[activeTab]?.url] ?? '';
		const plain: Segment[] = [{ text: raw, mark: false, first: false }];
		if (!highlightName) return plain;
		const base = stripVariant(highlightName);
		return markInto(raw, highlightName) ?? (base ? markInto(raw, base) : null) ?? plain;
	});

	/** Scrolls the first highlight into view whenever the marked text changes. */
	function scrollToHit(node: HTMLElement) {
		void pageSegments;
		node.querySelector('#firsthit')?.scrollIntoView({ block: 'center' });
	}

	function focusItem(item: GoldItem): void {
		const page = pageOf(item.name);
		if (page >= 0) activeTab = page;
		highlightName = item.name;
	}

	// --- editing + autosave -------------------------------------------------------

	let saveTimer: ReturnType<typeof setTimeout> | undefined;

	function markDirty(): void {
		saveState = 'dirty';
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => void save(), 700);
	}

	async function save(): Promise<void> {
		saveState = 'saving';
		const result = await saveGold({
			task: data.task,
			file: data.file,
			items: $state.snapshot(items) as GoldItem[],
			sources: sourcesText
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean),
			reviewed: $state.snapshot(reviewed)
		});
		if (result.ok) {
			saveState = 'saved';
			saveError = '';
		} else {
			saveState = 'failed';
			saveError = (result.issues ?? [result.error ?? 'save failed']).join('; ');
		}
	}

	function toggleReviewed(name: string, checked: boolean): void {
		const without = reviewed.filter((entry) => entry !== name);
		reviewed = checked ? [...without, name] : without;
		markDirty();
	}

	function toggleTag(
		item: GoldItem,
		field: 'tags' | 'optional_tags',
		tag: (typeof DIETARY)[number]
	): void {
		const next = item[field].includes(tag)
			? item[field].filter((entry) => entry !== tag)
			: [...item[field], tag];
		item[field] = DIETARY.filter((entry) => next.includes(entry)) as GoldItem['tags'];
		markDirty();
	}

	function deleteItem(index: number): void {
		items.splice(index, 1);
		markDirty();
	}

	function addItem(): void {
		items.push({ name: '', description: null, tags: [], optional_tags: [], price: null });
		markDirty();
	}

	async function promote(): Promise<void> {
		promoteOut = null;
		await save();
		const result = await promoteGold(data.task, policyVersion.trim());
		promoteOut = result.ok
			? {
					ok: true,
					text: `promoted → gold/data.json${(result.warnings ?? []).length ? ` (${result.warnings?.length} warning(s))` : ''}`
				}
			: {
					ok: false,
					text: `${result.error ?? 'failed'}: ${(result.errors ?? result.issues ?? []).slice(0, 12).join(' | ')}`
				};
	}
</script>

<Card.Root size="sm" class="gap-0 px-3.5 py-2.5">
	<div class="flex flex-wrap items-center gap-3">
		<Button variant="outline" size="xs" onclick={() => router.go('authoring')}>← Authoring</Button>
		<strong class="font-mono">{data.task}</strong>
		<span class="text-[11px] text-muted-foreground">gold/{data.file}.json</span>
		<span class="text-[11px] tabular-nums">
			reviewed {reviewedCount}/{items.length} ·
			<span class={zeroCount > 0 ? 'text-critical' : 'text-good'}>zero-hit {zeroCount}</span>
		</span>
		<span
			class="text-[11px] {saveState === 'dirty' || saveState === 'failed'
				? 'text-critical'
				: saveState === 'saved'
					? 'text-good'
					: 'text-muted-foreground'}"
		>
			{saveState === 'failed' ? `save failed: ${saveError}` : saveState}
		</span>
		{#if data.can_promote}
			<span class="ml-auto flex items-center gap-2">
				<Label class="gap-1.5 text-[11px] font-normal text-muted-foreground"
					>policy_version <Input bind:value={policyVersion} class="h-7 w-[110px] text-xs" /></Label
				>
				<Button size="sm" onclick={promote}>Promote</Button>
			</span>
		{/if}
		{#if promoteOut}
			<span class="max-w-[380px] text-[11px] {promoteOut.ok ? 'text-good' : 'text-critical'}"
				>{promoteOut.text}</span
			>
		{/if}
	</div>
</Card.Root>

<div class="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
	<Card.Root
		size="sm"
		class="sticky top-[120px] block max-h-[calc(100vh-140px)] gap-0 overflow-auto px-3.5 py-3"
	>
		<div class="sticky top-0 z-[1] -mt-3 flex flex-wrap gap-1 bg-card pt-3 pb-1.5">
			{#each data.pages as page, i (page.url)}
				<Chip
					pressed={activeTab === i}
					title={page.url}
					onPressedChange={() => {
						activeTab = i;
						highlightName = null;
					}}>{page.title || page.url}</Chip
				>
			{/each}
		</div>
		<pre
			class="m-0 font-mono text-xs leading-normal break-words whitespace-pre-wrap [&_mark]:rounded-[2px] [&_mark]:bg-warning [&_mark]:px-px [&_mark]:text-black"
			{@attach scrollToHit}>{#each pageSegments as segment, i (i)}{#if segment.mark}<mark
						id={segment.first ? 'firsthit' : undefined}>{segment.text}</mark
					>{:else}{segment.text}{/if}{/each}</pre>
	</Card.Root>

	<section class="flex min-w-0 flex-col gap-2">
		<Card.Root size="sm" class="gap-1 px-3.5 py-2.5">
			<Label for="gold-sources" class="text-[11px] font-normal text-muted-foreground"
				>sources (one per line)</Label
			>
			<Textarea
				id="gold-sources"
				rows={2}
				spellcheck={false}
				bind:value={sourcesText}
				oninput={markDirty}
				class="min-h-0 font-mono text-xs"
			/>
		</Card.Root>

		{#each items as item, index (index)}
			{@const zero = pageOf(item.name) < 0}
			{@const isReviewed = reviewed.includes(item.name)}
			<Card.Root
				size="sm"
				class="gap-0 px-3.5 py-2.5 {zero ? 'border-critical ring-critical' : ''} {isReviewed
					? 'opacity-70'
					: ''}"
			>
				<div class="flex items-center gap-2">
					<Input
						bind:value={item.name}
						onfocus={() => focusItem(item)}
						oninput={markDirty}
						class="h-8 flex-1 text-[13px] font-semibold"
					/>
					{#if zero}<UiBadge class="border-transparent bg-critical font-bold text-white"
							>NO HITS</UiBadge
						>{/if}
					<Button
						variant="ghost"
						size="xs"
						class="text-critical hover:text-critical"
						onclick={() => deleteItem(index)}>Delete</Button
					>
				</div>
				<Textarea
					placeholder="description (verbatim, or leave blank for null)"
					value={item.description ?? ''}
					oninput={(event) => {
						const value = event.currentTarget.value;
						item.description = value.trim() === '' ? null : value;
						markDirty();
					}}
					class="mt-1.5 min-h-[34px] text-[13px]"
				/>
				<div class="mt-1.5 flex flex-wrap items-center gap-2">
					<Input
						placeholder="price"
						value={item.price ?? ''}
						oninput={(event) => {
							const raw = event.currentTarget.value.trim();
							item.price = raw === '' ? null : Number(raw);
							markDirty();
						}}
						class="h-7 w-20 text-xs"
					/>
					<Input
						placeholder="warning (optional)"
						value={item.warning ?? ''}
						oninput={(event) => {
							const raw = event.currentTarget.value;
							item.warning = raw.trim() === '' ? null : raw;
							markDirty();
						}}
						class="h-7 min-w-[140px] flex-1 text-xs"
					/>
					<Label class="gap-1.5 text-[11px] font-normal">
						<Checkbox
							checked={isReviewed}
							onCheckedChange={(checked) => toggleReviewed(item.name, checked === true)}
						/>
						reviewed
					</Label>
				</div>
				<div class="mt-1.5 flex flex-wrap gap-2 text-[11px]">
					{#each ['tags', 'optional_tags'] as const as field (field)}
						<fieldset class="m-0 flex flex-wrap gap-2 rounded-md border border-dashed px-1.5 py-1">
							<legend class="px-1 text-[11px] text-muted-foreground"
								>{field === 'tags' ? 'tags' : 'optional'}</legend
							>
							{#each DIETARY as tag (tag)}
								<Label class="gap-1 text-[11px] font-normal">
									<Checkbox
										class="size-3.5"
										checked={item[field].includes(tag)}
										onCheckedChange={() => toggleTag(item, field, tag)}
									/>
									{tag.replace('_', ' ')}
								</Label>
							{/each}
						</fieldset>
					{/each}
				</div>
			</Card.Root>
		{/each}
		<Button variant="outline" size="sm" class="self-start" onclick={addItem}>+ Add item</Button>
	</section>
</div>
