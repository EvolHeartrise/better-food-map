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

	const escapeHtml = (value: string): string =>
		value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
	const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	function markInto(escaped: string, needle: string): string | null {
		const trimmed = escapeHtml(needle).trim();
		if (!trimmed) return null;
		const re = new RegExp(escapeRe(trimmed).replace(/(?:\\?\s)+/g, '\\s+'), 'gi');
		let first = true;
		let matched = false;
		const out = escaped.replace(re, (m) => {
			matched = true;
			const id = first ? ' id="firsthit"' : '';
			first = false;
			return `<mark${id}>${m}</mark>`;
		});
		return matched ? out : null;
	}

	/** Escaped page text with the highlighted name marked; plain text otherwise. */
	let pageHtml = $derived.by(() => {
		if (data.pages.length === 0) return '';
		const raw = pageTexts[data.pages[activeTab]?.url] ?? '';
		const escaped = escapeHtml(raw);
		if (!highlightName) return escaped;
		const base = stripVariant(highlightName);
		return markInto(escaped, highlightName) ?? (base ? markInto(escaped, base) : null) ?? escaped;
	});

	/** Scrolls the first highlight into view whenever the marked text changes. */
	function scrollToHit(node: HTMLElement) {
		void pageHtml;
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

<div class="card head">
	<button class="chip" onclick={() => router.go('authoring')}>← Authoring</button>
	<strong class="mono">{data.task}</strong>
	<span class="muted small">gold/{data.file}.json</span>
	<span class="stat small">
		reviewed {reviewedCount}/{items.length} ·
		<span class={zeroCount > 0 ? 'bad' : 'good'}>zero-hit {zeroCount}</span>
	</span>
	<span class="small save-{saveState}">
		{saveState === 'failed' ? `save failed: ${saveError}` : saveState}
	</span>
	{#if data.can_promote}
		<span class="promote">
			<label class="small muted"
				>policy_version <input class="pv" bind:value={policyVersion} /></label
			>
			<button class="chip primary" onclick={promote}>Promote</button>
		</span>
	{/if}
	{#if promoteOut}
		<span class="small {promoteOut.ok ? 'good' : 'bad'} out">{promoteOut.text}</span>
	{/if}
</div>

<div class="panes">
	<section class="left card">
		<div class="tabs">
			{#each data.pages as page, i (page.url)}
				<button
					class="chip"
					aria-pressed={activeTab === i}
					title={page.url}
					onclick={() => {
						activeTab = i;
						highlightName = null;
					}}>{page.title || page.url}</button
				>
			{/each}
		</div>
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- own-escaped text; only our <mark> tags survive -->
		<pre class="pagetext" {@attach scrollToHit}>{@html pageHtml}</pre>
	</section>

	<section class="right">
		<label class="sources card">
			<span class="muted small">sources (one per line)</span>
			<textarea rows="2" spellcheck="false" bind:value={sourcesText} oninput={markDirty}></textarea>
		</label>

		{#each items as item, index (index)}
			{@const zero = pageOf(item.name) < 0}
			{@const isReviewed = reviewed.includes(item.name)}
			<div class="item card" class:zero class:reviewed={isReviewed}>
				<div class="row1">
					<input
						class="name"
						bind:value={item.name}
						onfocus={() => focusItem(item)}
						oninput={markDirty}
					/>
					{#if zero}<span class="badge">NO HITS</span>{/if}
					<button class="chip del" onclick={() => deleteItem(index)}>Delete</button>
				</div>
				<textarea
					class="desc"
					placeholder="description (verbatim, or leave blank for null)"
					value={item.description ?? ''}
					oninput={(event) => {
						const value = event.currentTarget.value;
						item.description = value.trim() === '' ? null : value;
						markDirty();
					}}
				></textarea>
				<div class="meta">
					<input
						class="price"
						placeholder="price"
						value={item.price ?? ''}
						oninput={(event) => {
							const raw = event.currentTarget.value.trim();
							item.price = raw === '' ? null : Number(raw);
							markDirty();
						}}
					/>
					<input
						class="warning"
						placeholder="warning (optional)"
						value={item.warning ?? ''}
						oninput={(event) => {
							const raw = event.currentTarget.value;
							item.warning = raw.trim() === '' ? null : raw;
							markDirty();
						}}
					/>
					<label class="small rev">
						<input
							type="checkbox"
							checked={isReviewed}
							onchange={(event) => toggleReviewed(item.name, event.currentTarget.checked)}
						/>
						reviewed
					</label>
				</div>
				<div class="tags small">
					{#each ['tags', 'optional_tags'] as const as field (field)}
						<fieldset>
							<legend>{field === 'tags' ? 'tags' : 'optional'}</legend>
							{#each DIETARY as tag (tag)}
								<label>
									<input
										type="checkbox"
										checked={item[field].includes(tag)}
										onchange={() => toggleTag(item, field, tag)}
									/>
									{tag.replace('_', ' ')}
								</label>
							{/each}
						</fieldset>
					{/each}
				</div>
			</div>
		{/each}
		<button class="chip add" onclick={addItem}>+ Add item</button>
	</section>
</div>

<style>
	.head {
		display: flex;
		gap: 12px;
		align-items: center;
		flex-wrap: wrap;
	}

	.stat {
		font-variant-numeric: tabular-nums;
	}

	.save-dirty,
	.save-failed {
		color: var(--critical);
	}

	.save-saved {
		color: var(--good);
	}

	.promote {
		margin-left: auto;
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.pv {
		width: 100px;
	}

	.out {
		max-width: 380px;
	}

	.panes {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
		align-items: start;
		margin-top: 16px;
	}

	.left {
		position: sticky;
		top: 120px;
		max-height: calc(100vh - 140px);
		overflow: auto;
	}

	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		position: sticky;
		top: 0;
		background: var(--surface-1);
		padding-bottom: 6px;
		z-index: 1;
	}

	.pagetext {
		white-space: pre-wrap;
		word-break: break-word;
		font-family: var(--mono);
		font-size: 12px;
		line-height: 1.5;
		margin: 0;
	}

	.pagetext :global(mark) {
		background: var(--warning);
		color: inherit;
		padding: 0 1px;
		border-radius: 2px;
	}

	.right {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	.item.zero {
		border-color: var(--critical);
		box-shadow: 0 0 0 1px var(--critical) inset;
	}

	.item.reviewed {
		opacity: 0.7;
	}

	.row1 {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.name {
		flex: 1;
		font-weight: 600;
	}

	.badge {
		font-size: 11px;
		font-weight: 700;
		color: #fff;
		background: var(--critical);
		padding: 1px 6px;
		border-radius: 10px;
		white-space: nowrap;
	}

	.desc {
		width: 100%;
		resize: vertical;
		min-height: 34px;
		margin-top: 6px;
	}

	.meta {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-top: 6px;
		flex-wrap: wrap;
	}

	.price {
		width: 80px;
	}

	.warning {
		flex: 1;
		min-width: 140px;
	}

	.rev {
		display: inline-flex;
		gap: 4px;
		align-items: center;
	}

	.tags {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 6px;
	}

	fieldset {
		border: 1px dashed var(--border);
		border-radius: 6px;
		padding: 4px 6px;
		margin: 0;
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	legend {
		font-size: 11px;
		color: var(--text-secondary);
		padding: 0 4px;
	}

	fieldset label {
		display: inline-flex;
		gap: 3px;
		align-items: center;
	}

	input,
	textarea {
		font: inherit;
		font-size: 13px;
		padding: 4px 6px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-1);
		color: var(--text-primary);
	}

	.sources {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.sources textarea {
		font-family: var(--mono);
		font-size: 12px;
	}

	.del {
		color: var(--critical);
	}

	.add {
		align-self: flex-start;
	}

	.primary {
		background: var(--series-1);
		color: #fff;
		border-color: var(--series-1);
	}

	.mono {
		font-family: var(--mono);
	}

	.small {
		font-size: 11px;
	}

	.good {
		color: var(--good);
	}

	.bad {
		color: var(--critical);
	}
</style>
