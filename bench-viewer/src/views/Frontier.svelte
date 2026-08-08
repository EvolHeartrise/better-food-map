<script lang="ts">
	/**
	 * Quality against cost (or latency), with the Pareto frontier called out —
	 * the "what should we actually run" view.
	 *
	 * The cost axis can be flipped between REAL billed cost and the perfect-prefix-
	 * caching counterfactual the harness records alongside it. That second number
	 * is the interesting one for a menu-refresh workload: the bench loop is
	 * append-only, so a production caller that keeps its prefix warm pays closer to
	 * `price_cached` than to `price`.
	 */
	import { fetchCells, fetchRuns } from '../lib/api';
	import { count, duration, metricLabel, pct, usd } from '../lib/format';
	import { filters, router } from '../lib/state.svelte';
	import { frontierKeys as computeFrontier, plottableCells } from '../lib/analysis';
	import { modelIcon, providerIcon } from '../lib/icons';
	import type { CellRow, ScatterPoint } from '../lib/types';
	import Chip from '../components/Chip.svelte';
	import ScatterChart from '../components/ScatterChart.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { Separator } from '$lib/components/ui/separator';
	import * as Table from '$lib/components/ui/table';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';

	type XAxis = 'cost' | 'cost_cached' | 'duration';

	/**
	 * Grouping with and without the attribution axes.
	 *
	 * SPLIT is the server default and the honest one: a score measures model x
	 * provider x quantization x prompt, so runs served by different endpoints are
	 * not repeats of one measurement. POOLED drops `provenance` and `prompt_sha`
	 * only — `harness` stays split either way, because a two-pass run and a
	 * single-pass run are different SYSTEMS, not two samples of one, and pooling
	 * them would put a number on the chart describing neither.
	 */
	const SPLIT_DIMS = [
		'model',
		'backend',
		'effort',
		'temperature',
		'quantization',
		'provenance',
		'harness',
		'review',
		'prompt_sha'
	];
	const POOLED_DIMS = [
		'model',
		'backend',
		'effort',
		'temperature',
		'quantization',
		'harness',
		'review'
	];

	const X_AXES: Record<XAxis, { label: string; format: (value: number) => string }> = {
		cost: { label: 'Cost per run (USD, real)', format: usd },
		cost_cached: { label: 'Cost per run (USD, perfect prefix cache)', format: usd },
		duration: { label: 'Agent wall-clock', format: duration }
	};

	let xAxis = $state<XAxis>('cost');
	let splitProvenance = $state(true);
	/** The cell whose runs are expanded below the chart, or null. */
	let selectedKey = $state<string | null>(null);

	let dims = $derived(
		filters.dimensions.length > 0 ? filters.dimensions : splitProvenance ? SPLIT_DIMS : POOLED_DIMS
	);

	let response = $derived(await fetchCells(filters.query, filters.mode, dims));
	let cells = $derived(response.cells);
	// The same slice the chart is built from, so an expanded point can show its
	// runs without a second round of filtering logic that could drift from it.
	let runsResponse = $derived(await fetchRuns(filters.query));

	function xValue(cell: CellRow): number | null {
		if (xAxis === 'cost') return cell.stats.cost_usd.mean;
		if (xAxis === 'cost_cached') return cell.stats.price_cached.mean;
		return cell.stats.duration_ms.mean;
	}

	// --- advanced filters (this chart only) --------------------------------------
	/**
	 * These narrow which CELLS are plotted, not which runs are in the slice: the
	 * shared FilterBar owns the slice every view renders against, and these
	 * compose on top of it for frontier questions ("pinned runs only", "hide n=1
	 * cells", "only two-pass"). Nothing narrows silently — every cell or point
	 * they hide is counted in the note under the chart, next to a Reset.
	 */
	const FACETS = [
		{ key: 'harness', label: 'Harness' },
		{ key: 'backend', label: 'Backend' },
		{ key: 'quantization', label: 'Quantization' },
		{ key: 'provenance', label: 'Provider' },
		{ key: 'prompt_sha', label: 'Prompt' }
	] as const;
	type FacetKey = (typeof FACETS)[number]['key'];

	const emptySelections = (): Record<FacetKey, string[]> => ({
		harness: [],
		backend: [],
		quantization: [],
		provenance: [],
		prompt_sha: []
	});

	let advancedOpen = $state(false);
	let facetSelections = $state<Record<FacetKey, string[]>>(emptySelections());
	/** Cells with fewer runs than this are hidden — an n=1 cell is one sample, not a mean. */
	let minRuns = $state(1);
	/** Floor on the selected metric, in percent; 0 = off. */
	let qualityFloor = $state(0);
	/** Ceiling on the x axis (USD; seconds when the axis is latency), as typed. */
	let xCeilingRaw = $state('');
	let frontierOnly = $state(false);

	/** A cell not split on a facet has no value there — a real bucket, not a blank. */
	const facetValue = (cell: CellRow, key: FacetKey): string => cell[key] ?? '(not split)';

	let facetOptions = $derived.by(() => {
		const out = {} as Record<FacetKey, { value: string; n: number }[]>;
		for (const facet of FACETS) {
			const counts: Record<string, number> = {};
			for (const cell of cells) {
				const value = facetValue(cell, facet.key);
				counts[value] = (counts[value] ?? 0) + 1;
			}
			out[facet.key] = Object.entries(counts)
				.map(([value, n]) => ({ value, n }))
				.toSorted((a, b) => a.value.localeCompare(b.value));
		}
		return out;
	});

	function toggleFacet(key: FacetKey, value: string): void {
		const current = facetSelections[key];
		facetSelections[key] = current.includes(value)
			? current.filter((entry) => entry !== value)
			: [...current, value];
	}

	let xCeiling = $derived.by(() => {
		const parsed = Number(xCeilingRaw);
		return xCeilingRaw.trim() === '' || !Number.isFinite(parsed) || parsed <= 0 ? null : parsed;
	});
	/** The input is USD, or SECONDS on the latency axis — x values there are ms. */
	let xCeilingValue = $derived(
		xCeiling === null ? null : xAxis === 'duration' ? xCeiling * 1000 : xCeiling
	);

	let advancedActive = $derived(
		FACETS.some((facet) => facetSelections[facet.key].length > 0) ||
			minRuns > 1 ||
			qualityFloor > 0 ||
			xCeiling !== null ||
			frontierOnly
	);

	function resetAdvanced(): void {
		facetSelections = emptySelections();
		minRuns = 1;
		qualityFloor = 0;
		xCeilingRaw = '';
		frontierOnly = false;
	}

	let facetFiltered = $derived(
		cells.filter(
			(cell) =>
				cell.n_runs >= minRuns &&
				FACETS.every(
					(facet) =>
						facetSelections[facet.key].length === 0 ||
						facetSelections[facet.key].includes(facetValue(cell, facet.key))
				)
		)
	);
	let hiddenByFacets = $derived(cells.length - facetFiltered.length);

	const taskList = (value: string): string[] => (value ? value.split('+') : []);

	/**
	 * How many distinct tasks any cell in this slice actually produced a score on.
	 * This is the coverage bar a cell has to clear to be comparable — computed
	 * over the UNFILTERED slice on purpose: picking a harness in the advanced
	 * panel narrows what is shown, it must never lower the bar a shown cell has
	 * to clear.
	 */
	let sliceTaskCount = $derived(new Set(cells.flatMap((cell) => taskList(cell.scored_tasks))).size);

	let plottedAll = $derived(plottableCells(facetFiltered, xValue, filters.metric));

	/**
	 * Only cells scored on EVERY task in the slice are plotted.
	 *
	 * A frontier is a claim that nothing beats these points on both axes, and that
	 * claim is meaningless across configurations measured on different venues: a
	 * cell that only ran the easiest task scores near the ceiling for a fraction of
	 * the cost and lands on the frontier looking like the thing to run. That is not
	 * a cheaper configuration, it is a smaller sample of an easier question.
	 */
	let plotted = $derived(
		plottedAll.filter((entry) => taskList(entry.cell.scored_tasks).length >= sliceTaskCount)
	);

	// Exclusions are counted BY CAUSE and always surfaced. Silently dropping a
	// third of the corpus is how a chart says "we compared everything" about a
	// slice. Counted over the facet-filtered set; what the ADVANCED filters hid
	// is its own count, stated separately with a Reset beside it.
	let excludedNoScore = $derived(
		facetFiltered.filter((cell) => cell.metrics[filters.metric].mean === null).length
	);
	let excludedNoAxis = $derived(facetFiltered.length - plottedAll.length - excludedNoScore);
	let excludedPartial = $derived(plottedAll.length - plotted.length);
	let excluded = $derived(facetFiltered.length - plotted.length);

	/** Quality floor and x ceiling apply to plotted points, after coverage. */
	let thresholded = $derived(
		plotted.filter(
			(entry) =>
				entry.y >= qualityFloor / 100 && (xCeilingValue === null || entry.x <= xCeilingValue)
		)
	);
	let hiddenByThresholds = $derived(plotted.length - thresholded.length);

	/**
	 * The frontier is computed over the VISIBLE point set: with a floor or
	 * ceiling active, the chart's claim is "nothing shown beats these", and a
	 * frontier anchored to hidden points would label the wrong ones.
	 */
	let frontier = $derived(computeFrontier(thresholded));

	let visible = $derived(
		frontierOnly ? thresholded.filter((entry) => frontier.has(entry.cell.key)) : thresholded
	);

	/**
	 * Point labels only carry the axes that actually distinguish them.
	 *
	 * `model · effort` alone rendered three different `deepseek-v4-flash · low`
	 * points identically — one of them a single run on one task. A label that
	 * cannot tell two points apart is worse than a long one, so the disambiguators
	 * are appended only where a base label collides.
	 */
	let baseLabelCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const entry of visible) {
			const base = `${entry.cell.model.split('/').pop()} · ${entry.cell.effort}`;
			counts[base] = (counts[base] ?? 0) + 1;
		}
		return counts;
	});

	function labelFor(cell: CellRow): string {
		const base = `${cell.model.split('/').pop()} · ${cell.effort}`;
		if ((baseLabelCounts[base] ?? 0) <= 1) return base;
		const extra = [
			cell.harness && cell.harness !== 'single-pass' ? cell.harness : null,
			cell.quantization && cell.quantization !== 'unpinned' ? cell.quantization : null,
			// The provider, not the whole provenance string, which is too long here.
			cell.provenance ? cell.provenance.split(' ')[0].split('@')[0] : null
		].filter(Boolean);
		return `${base}${extra.length ? ` · ${extra.join(' · ')}` : ''}`;
	}

	/** Runs belonging to the expanded cell, richest-context first. */
	let selectedCell = $derived(
		selectedKey === null ? null : (cells.find((cell) => cell.key === selectedKey) ?? null)
	);

	let selectedRuns = $derived.by(() => {
		if (!selectedCell) return [];
		const ids = new Set(selectedCell.run_ids);
		return runsResponse.runs
			.filter((run) => ids.has(run.run_id))
			.toSorted((a, b) => a.task.localeCompare(b.task) || a.started_at.localeCompare(b.started_at));
	});

	let points = $derived.by<ScatterPoint[]>(() =>
		visible.map((entry) => ({
			id: entry.cell.key,
			label: labelFor(entry.cell),
			x: entry.x,
			y: entry.y,
			n: entry.cell.n_runs,
			frontier: frontier.has(entry.cell.key),
			icon: modelIcon(entry.cell.model),
			// Only badge the provider when provenance is a real axis of this chart:
			// pooled cells mix endpoints, and one endpoint's logo would claim them all.
			providerIcon: splitProvenance ? providerIcon(entry.cell.provenance) : null,
			detail: [
				`${entry.cell.n_runs} run(s) over ${entry.cell.n_tasks} task(s)`,
				entry.cell.harness && entry.cell.harness !== 'single-pass' ? entry.cell.harness : null,
				entry.cell.quantization && entry.cell.quantization !== 'unpinned'
					? entry.cell.quantization
					: null,
				splitProvenance && entry.cell.provenance ? entry.cell.provenance : null
			]
				.filter(Boolean)
				.join(' · ')
		}))
	);

	let tableRows = $derived(visible.toSorted((a, b) => b.y - a.y || a.x - b.x));

	/**
	 * Selecting a point EXPANDS it rather than navigating.
	 *
	 * This used to jump straight to `run_ids[0]`, which showed one arbitrary run —
	 * in practice whichever task sorted first — and read as though the point WAS
	 * that run. A point is an average over a cell; the useful drill-down is the
	 * set it averages over.
	 */
	function selectCell(cellKey: string): void {
		selectedKey = selectedKey === cellKey ? null : cellKey;
	}
</script>

<div class="flex flex-col gap-4">
	<Card.Root size="sm">
		<Card.Content>
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 class="text-[15px]">
						{metricLabel(filters.metric)} against {X_AXES[xAxis].label.toLowerCase()}
					</h2>
					<p class="text-[11px] text-muted-foreground">
						Labelled points are the Pareto frontier — nothing beats them on both axes. Point
						identity is in the tooltip and the table below, not in colour.
					</p>
					{#if !splitProvenance}
						<p class="max-w-[80ch] text-[11px] text-serious">
							Pooled: runs served by different providers, quantizations and prompts share a point,
							so each one describes no single actual endpoint. Good for ranking models, not for
							attributing a score. (Harness stays split — a two-pass run is a different system, not
							another sample.)
						</p>
					{/if}
					{#if filters.dimensions.length > 0}
						<p class="text-[11px] text-muted-foreground">
							Grouping is pinned by the filter panel, so the split toggle does not apply.
						</p>
					{/if}
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<ToggleGroup.Root
						type="single"
						value={xAxis}
						onValueChange={(value) => {
							if (value) xAxis = value as XAxis;
						}}
						variant="outline"
						size="sm"
					>
						<ToggleGroup.Item value="cost" class="h-7 px-2.5 text-xs">Real cost</ToggleGroup.Item>
						<ToggleGroup.Item value="cost_cached" class="h-7 px-2.5 text-xs"
							>Cached cost</ToggleGroup.Item
						>
						<ToggleGroup.Item value="duration" class="h-7 px-2.5 text-xs">Latency</ToggleGroup.Item>
					</ToggleGroup.Root>
					<Label
						class="gap-1.5 text-[11px] font-normal whitespace-nowrap text-muted-foreground"
						title="A score measures model x provider x quantization x prompt. Pooling those axes gives one number that describes no single endpoint — useful for comparing models, wrong for attributing a result."
					>
						<Checkbox bind:checked={splitProvenance} />
						split by provenance &amp; prompt
					</Label>
					<Chip
						pressed={advancedOpen}
						title="Filter which cells are plotted: harness, backend, quantization, provider, prompt, minimum runs, quality floor, cost ceiling."
						onPressedChange={(next) => (advancedOpen = next)}
					>
						Advanced{advancedActive ? ' ·' : ''}
					</Chip>
				</div>
			</div>

			{#if advancedOpen}
				<Separator class="mt-2.5" />
				<div class="mt-2.5 flex flex-col gap-2">
					{#each FACETS as facet (facet.key)}
						{#if facetOptions[facet.key].length > 1}
							<div class="flex flex-wrap items-baseline gap-2">
								<span class="min-w-[100px] text-xs text-muted-foreground">{facet.label}</span>
								<div class="flex flex-wrap items-center gap-1.5">
									{#each facetOptions[facet.key] as option (option.value)}
										<Chip
											pressed={facetSelections[facet.key].includes(option.value)}
											onPressedChange={() => toggleFacet(facet.key, option.value)}
										>
											<span class={facet.key === 'prompt_sha' ? 'font-mono text-[11px]' : ''}
												>{option.value}</span
											>
											<span class="text-muted-foreground">{option.n}</span>
										</Chip>
									{/each}
								</div>
							</div>
						{/if}
					{/each}

					<div class="flex flex-wrap items-center gap-2">
						<span class="min-w-[100px] text-xs text-muted-foreground">Min runs/cell</span>
						<Select.Root
							type="single"
							value={String(minRuns)}
							onValueChange={(value) => (minRuns = Number(value))}
						>
							<Select.Trigger size="sm" class="h-7 text-xs">
								{minRuns === 1 ? 'any' : `≥ ${minRuns}`}
							</Select.Trigger>
							<Select.Content>
								{#each [1, 2, 3, 5] as n (n)}
									<Select.Item value={String(n)} label={n === 1 ? 'any' : `≥ ${n}`} />
								{/each}
							</Select.Content>
						</Select.Root>
						<span class="text-[11px] text-muted-foreground"
							>An n=1 cell is a single sample, not a mean.</span
						>
					</div>

					<div class="flex flex-wrap items-center gap-2">
						<span class="min-w-[100px] text-xs text-muted-foreground">Quality floor</span>
						<Input
							type="number"
							min="0"
							max="100"
							step="5"
							bind:value={qualityFloor}
							class="h-7 w-20 text-xs"
						/>
						<span class="text-[11px] text-muted-foreground"
							>% {metricLabel(filters.metric).toLowerCase()} — points below are hidden.</span
						>
					</div>

					<div class="flex flex-wrap items-center gap-2">
						<span class="min-w-[100px] text-xs text-muted-foreground"
							>{xAxis === 'duration' ? 'Latency ceiling' : 'Cost ceiling'}</span
						>
						<Input
							type="text"
							inputmode="decimal"
							placeholder={xAxis === 'duration' ? 'seconds' : 'USD'}
							bind:value={xCeilingRaw}
							class="h-7 w-20 text-xs"
						/>
						<span class="text-[11px] text-muted-foreground">
							{xAxis === 'duration' ? 'seconds per run' : 'USD per run'} — points above are hidden.
						</span>
					</div>

					<div class="flex flex-wrap items-center gap-2">
						<span class="min-w-[100px] text-xs text-muted-foreground">Frontier</span>
						<Chip pressed={frontierOnly} onPressedChange={(next) => (frontierOnly = next)}>
							{frontierOnly ? 'frontier points only' : 'all points'}
						</Chip>
						{#if advancedActive}
							<Button variant="ghost" size="xs" onclick={resetAdvanced}>Reset advanced</Button>
						{/if}
					</div>
				</div>
			{/if}

			<ScatterChart
				{points}
				xLabel={X_AXES[xAxis].label}
				yLabel={metricLabel(filters.metric)}
				formatX={X_AXES[xAxis].format}
				formatY={(value) => pct(value, 0)}
				logX={xAxis !== 'duration'}
				onselect={selectCell}
			/>

			{#if advancedActive}
				<!-- The advanced filters' narrowing, stated as its own sentence: these are
				     the user's deliberate hides, not data problems, so they are counted
				     apart from the omitted-by-cause note below. -->
				<p class="mt-2 text-[11px] text-muted-foreground">
					Advanced filters hide {hiddenByFacets} cell{hiddenByFacets === 1
						? ''
						: 's'}{hiddenByThresholds > 0
						? ` and ${hiddenByThresholds} plotted point${hiddenByThresholds === 1 ? '' : 's'}`
						: ''}{frontierOnly
						? `; showing only the ${visible.length} frontier point${visible.length === 1 ? '' : 's'}`
						: ''}.
					<button
						class="cursor-pointer text-primary underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						onclick={resetAdvanced}>Reset</button
					>
				</p>
			{/if}

			{#if excluded > 0}
				{@const causes = [
					excludedNoAxis > 0
						? `${excludedNoAxis} with no ${xAxis === 'duration' ? 'duration' : 'cost'} reported`
						: null,
					excludedNoScore > 0
						? `${excludedNoScore} with no ${metricLabel(filters.metric).toLowerCase()} to plot`
						: null,
					excludedPartial > 0
						? `${excludedPartial} scored on only some of the ${sliceTaskCount} task(s) in this slice`
						: null
				].filter(Boolean)}
				<p class="mt-2 text-[11px] text-muted-foreground">
					{excluded} cell{excluded === 1 ? '' : 's'} omitted{causes.length
						? `: ${causes.join(', ')}`
						: ''}. Omitted, never plotted at zero — unreported is unknown, not free and not worst.
					{#if excludedPartial > 0}
						A configuration measured on fewer venues is a smaller sample of an easier question, not
						a cheaper configuration; it cannot be compared on this chart.
					{/if}
				</p>
			{/if}
		</Card.Content>
	</Card.Root>

	{#if selectedCell}
		<Card.Root size="sm">
			<Card.Content>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div>
						<h3 class="text-[13px]">
							{selectedCell.model}
							<span class="text-muted-foreground">· {selectedCell.effort}</span>
						</h3>
						<p class="text-[11px] text-muted-foreground">
							{selectedCell.n_runs} run{selectedCell.n_runs === 1 ? '' : 's'} over
							{selectedCell.n_tasks} task{selectedCell.n_tasks === 1 ? '' : 's'} ·
							{selectedCell.harness}{selectedCell.review && selectedCell.review !== 'none'
								? ` · review: ${selectedCell.review}`
								: ''}{selectedCell.quantization && selectedCell.quantization !== 'unpinned'
								? ` · ${selectedCell.quantization}`
								: ''}{splitProvenance && selectedCell.provenance
								? ` · ${selectedCell.provenance}`
								: ''}
						</p>
						<!-- The plotted point is a MEAN over these rows. Saying so beside them is
						     what stops a reader treating the point as a single result. -->
						<p class="text-[11px] text-muted-foreground">
							The plotted point is the task-equal (macro) average of these runs:
							<strong>{pct(selectedCell.metrics[filters.metric].mean)}</strong>
							{metricLabel(filters.metric).toLowerCase()} at
							<strong>{X_AXES[xAxis].format(xValue(selectedCell) ?? 0)}</strong>.
						</p>
					</div>
					<Button variant="outline" size="xs" onclick={() => (selectedKey = null)}>Close</Button>
				</div>

				<Table.Root class="num-table mt-2 text-[13px] tabular-nums">
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head class="text-xs">Task</Table.Head>
							<Table.Head class="text-xs">Item R</Table.Head>
							<Table.Head class="text-xs">Item P</Table.Head>
							<Table.Head class="text-xs">Tag R</Table.Head>
							<Table.Head class="text-xs">Tag P</Table.Head>
							<Table.Head class="text-xs">Cost</Table.Head>
							<Table.Head class="text-xs">Time</Table.Head>
							<Table.Head class="text-xs">Tokens</Table.Head>
							<Table.Head class="text-left text-xs">Started</Table.Head>
							<Table.Head></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each selectedRuns as run (run.run_id)}
							<Table.Row class={run.status === 'failed' ? 'opacity-75' : ''}>
								<Table.Cell>{run.task}</Table.Cell>
								{#if run.status === 'failed'}
									<!-- A failed run has no report and is never counted as 0% — it is not
									     in the mean above either. -->
									<Table.Cell colspan={5} class="text-left text-muted-foreground">
										failed{run.failure_reason ? `: ${run.failure_reason.slice(0, 70)}` : ''}
									</Table.Cell>
								{:else}
									<Table.Cell>{pct(run.item_recall)}</Table.Cell>
									<Table.Cell>{pct(run.item_precision)}</Table.Cell>
									<Table.Cell>{pct(run.tag_recall)}</Table.Cell>
									<Table.Cell>{pct(run.tag_precision)}</Table.Cell>
									<Table.Cell>{usd(run.cost_usd)}</Table.Cell>
								{/if}
								<Table.Cell>{duration(run.duration_ms)}</Table.Cell>
								<Table.Cell>{count(run.total_tokens)}</Table.Cell>
								<Table.Cell class="text-left text-[11px] text-muted-foreground"
									>{run.started_at.slice(0, 16).replace('T', ' ')}</Table.Cell
								>
								<Table.Cell>
									<button
										class="cursor-pointer text-xs text-primary underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
										onclick={() => router.go('run', { id: run.run_id })}
									>
										open →
									</button>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>

				{#if selectedRuns.length !== selectedCell.n_runs}
					<p class="mt-2 text-[11px] text-muted-foreground">
						Showing {selectedRuns.length} of {selectedCell.n_runs} runs — the rest are outside the current
						filter slice.
					</p>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root size="sm">
		<Card.Header class="gap-0">
			<Card.Title class="text-[13px]">Table view</Card.Title>
		</Card.Header>
		<Card.Content>
			<Table.Root class="num-table text-[13px] tabular-nums">
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head class="text-xs">Configuration</Table.Head>
						<Table.Head class="text-xs">{metricLabel(filters.metric)}</Table.Head>
						<Table.Head class="text-xs">{X_AXES[xAxis].label}</Table.Head>
						<Table.Head class="text-xs">n</Table.Head>
						<Table.Head class="text-xs">Tasks</Table.Head>
						<Table.Head class="text-left text-xs">Frontier</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each tableRows as entry (entry.cell.key)}
						<!-- Clickable so the table and the chart select the same way; keyboard
						     reachable because a row is the only handle on a point whose label
						     the chart may have had to abbreviate. -->
						<Table.Row
							class="cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring {entry
								.cell.key === selectedKey
								? 'bg-primary/12 hover:bg-primary/12'
								: 'hover:bg-primary/5'}"
							onclick={() => selectCell(entry.cell.key)}
							onkeydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									selectCell(entry.cell.key);
								}
							}}
							tabindex={0}
							role="button"
							aria-pressed={entry.cell.key === selectedKey}
							aria-label="{entry.cell.model} {entry.cell.effort}: show runs"
						>
							<Table.Cell>
								{entry.cell.model} <span class="text-muted-foreground">· {entry.cell.effort}</span>
							</Table.Cell>
							<Table.Cell>{pct(entry.y)}</Table.Cell>
							<Table.Cell>{X_AXES[xAxis].format(entry.x)}</Table.Cell>
							<Table.Cell>{entry.cell.n_runs}</Table.Cell>
							<Table.Cell>{entry.cell.n_tasks}</Table.Cell>
							<Table.Cell class="text-left">
								{#if frontier.has(entry.cell.key)}<span class="text-xs font-semibold text-good"
										>on frontier</span
									>{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Content>
	</Card.Root>
</div>
