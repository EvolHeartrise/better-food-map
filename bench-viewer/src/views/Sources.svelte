<script lang="ts">
	/**
	 * Data sources & ingestion forecast — how many eateries each source knows
	 * about (OSM staging, Overture leads, the map itself), how many remain, and
	 * what ingesting them would cost at a measured bench rate.
	 *
	 * The cost basis is BENCH-DERIVED: pick any run configuration (a cell from
	 * the current slice) and its mean per-run cost becomes the $/menu, times an
	 * adjustable overhead multiplier — model cost is only part of ingesting a
	 * venue (page discovery, verification, retries), and menus are shared by
	 * chains, so the number is a planning estimate, labelled as such.
	 */
	import { fetchCells, fetchSourceCities, fetchSourcesSummary } from '../lib/api';
	import { usd } from '../lib/format';
	import { filters } from '../lib/state.svelte';
	import type { CityRow, RegionRow } from '../lib/types';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { Switch } from '$lib/components/ui/switch';
	import * as Table from '$lib/components/ui/table';

	let summary = $derived(await fetchSourcesSummary());

	/** Cost bases from the CURRENT slice's cells, priciest information first. */
	let cellsResponse = $derived(await fetchCells(filters.query, filters.mode, filters.dimensions));
	let costBases = $derived(
		cellsResponse.cells
			.map((cell) => {
				const real = cell.stats?.cost_usd?.mean ?? null;
				const cached = cell.stats?.price_cached?.mean ?? null;
				return {
					key: cell.key,
					label: [cell.model?.split('/').pop(), cell.effort, cell.harness]
						.filter(Boolean)
						.join(' · '),
					n: cell.n_runs,
					real,
					cached
				};
			})
			.filter((base) => base.real !== null)
			.toSorted((a, b) => b.n - a.n)
	);

	let basisKey = $state<string | null>(null);
	let useCached = $state(false);
	/** Research overhead over raw model cost; 3x is a deliberate rough default. */
	let overhead = $state(3);
	let basis = $derived(costBases.find((b) => b.key === basisKey) ?? costBases[0] ?? null);
	let perMenu = $derived.by(() => {
		if (!basis) return null;
		const raw = useCached ? basis.cached : basis.real;
		return raw === null ? null : raw * overhead;
	});

	let expandedRegion = $state<string | null>(null);
	let cities = $state<CityRow[]>([]);

	/**
	 * Restrict every column to venues with a website on file — the directly
	 * menu-researchable subset. One toggle switches ALL columns (including the
	 * map subtraction) so the table never mixes filtered and unfiltered numbers.
	 */
	let webOnly = $state(false);

	interface Counts {
		osm: number;
		leads: number;
		map_open: number;
		unique: number;
		remaining: number;
	}

	function counts(row: RegionRow | CityRow): Counts {
		return webOnly
			? {
					osm: row.osm_web,
					leads: row.leads_web,
					map_open: row.map_open_web,
					unique: row.unique_web,
					remaining: row.remaining_web
				}
			: {
					osm: row.osm,
					leads: row.leads,
					map_open: row.map_open,
					unique: row.unique_estimate,
					remaining: row.remaining_estimate
				};
	}

	async function toggleRegion(region: string): Promise<void> {
		if (expandedRegion === region) {
			expandedRegion = null;
			cities = [];
			return;
		}
		expandedRegion = region;
		cities = (await fetchSourceCities(region)).cities;
	}

	const cost = (venues: number): string => (perMenu === null ? '—' : usd(venues * perMenu));

	const num = (value: number): string => value.toLocaleString('en-US');

	function staleDays(iso: string | null): number | null {
		if (!iso) return null;
		return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
	}
</script>

{#if !summary.available}
	<Card.Root size="sm">
		<Card.Header class="gap-0">
			<Card.Title>Data sources</Card.Title>
		</Card.Header>
		<Card.Content class="text-critical">{summary.reason}</Card.Content>
	</Card.Root>
{:else if summary.sources}
	{@const s = summary.sources}
	<div class="flex flex-col gap-4">
		<Card.Root size="sm">
			<Card.Header class="gap-0">
				<Card.Title>Eateries by source</Card.Title>
			</Card.Header>
			<Card.Content>
				<div class="flex flex-wrap items-stretch gap-3">
					<div class="flex min-w-[180px] flex-col gap-0.5 rounded-lg border px-3.5 py-2">
						<span class="text-[11px] text-muted-foreground">OSM staging</span>
						<span class="text-[22px] font-semibold tabular-nums">{num(s.osm.total)}</span>
						<span class="text-[11px] text-muted-foreground"
							>{num(s.osm.named)} named · {num(s.osm.with_website)} with website · {num(
								s.osm.matched_overture
							)} Overture-matched</span
						>
					</div>
					<div class="flex min-w-[180px] flex-col gap-0.5 rounded-lg border px-3.5 py-2">
						<span class="text-[11px] text-muted-foreground">Overture leads</span>
						<span class="text-[22px] font-semibold tabular-nums">{num(s.overture_leads.total)}</span
						>
						<span class="text-[11px] text-muted-foreground"
							>{num(s.overture_leads.with_website)} with website · release {s.overture_leads
								.release ?? '—'} · not near any OSM POI</span
						>
					</div>
					<div class="flex min-w-[180px] flex-col gap-0.5 rounded-lg border px-3.5 py-2">
						<span class="text-[11px] text-muted-foreground">On the map</span>
						<span class="text-[22px] font-semibold tabular-nums">{num(s.map.open)}</span>
						<span class="text-[11px] text-muted-foreground">
							{s.map.closed} closed ·
							{#if s.map.mirror_found}
								mirror {staleDays(s.map.mirror_mtime)}d old
							{:else}
								no local mirror — run <code class="rounded bg-muted px-1 font-mono text-[11px]"
									>bun run db:pull</code
								>
							{/if}
						</span>
					</div>
				</div>
				<p class="mt-2 text-[11px] text-muted-foreground">{summary.method}</p>
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Header class="gap-0">
				<Card.Title>Ingestion cost basis</Card.Title>
			</Card.Header>
			<Card.Content>
				<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
					<Label class="gap-1.5 text-[11px] text-muted-foreground">
						configuration
						<Select.Root
							type="single"
							value={basis?.key}
							onValueChange={(value) => (basisKey = value)}
						>
							<Select.Trigger size="sm" class="h-7 max-w-[340px] text-xs">
								{#if basis}
									{basis.label} (n={basis.n}, {usd(basis.real ?? 0)}/run)
								{:else}
									no scored cells in slice
								{/if}
							</Select.Trigger>
							<Select.Content>
								{#each costBases as base (base.key)}
									<Select.Item
										value={base.key}
										label="{base.label} (n={base.n}, {usd(base.real ?? 0)}/run)"
									/>
								{/each}
							</Select.Content>
						</Select.Root>
					</Label>
					<Label class="gap-1.5 text-[11px] text-muted-foreground">
						<Checkbox bind:checked={useCached} disabled={basis?.cached === null} />
						cached-prefix cost
					</Label>
					<Label class="gap-1.5 text-[11px] text-muted-foreground">
						overhead ×
						<Input
							type="number"
							min="1"
							step="0.5"
							bind:value={overhead}
							class="h-7 w-[64px] text-xs"
						/>
					</Label>
					<span class="text-[11px] font-semibold">
						= {perMenu === null ? '—' : usd(perMenu)}/menu
					</span>
				</div>
				<p class="mt-2 text-[11px] text-muted-foreground">
					Mean bench run cost for the picked configuration × overhead (discovery, verification,
					retries). Chains share one menu across branches, so per-venue cost over-counts chain-heavy
					areas — treat totals as an upper bound.
				</p>
			</Card.Content>
		</Card.Root>

		{#each summary.countries ?? [] as country (country.country)}
			<Card.Root size="sm">
				<Card.Header class="gap-0">
					<Card.Title>{country.country} — by province</Card.Title>
					<Card.Action class="self-center">
						<Label class="gap-1.5 text-[11px] text-muted-foreground">
							<Switch bind:checked={webOnly} />
							with website only
						</Label>
					</Card.Action>
				</Card.Header>
				<Card.Content>
					{#if webOnly}
						<p class="mb-2 text-[11px] text-muted-foreground">
							All columns restricted to venues with a website on file — the directly
							menu-researchable subset. Venues without one need site discovery first.
						</p>
					{/if}
					<Table.Root class="num-table text-[13px] tabular-nums">
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								<Table.Head class="text-xs">region</Table.Head>
								<Table.Head class="text-xs">OSM</Table.Head>
								<Table.Head class="text-xs">leads</Table.Head>
								<Table.Head class="text-xs">unique (est.)</Table.Head>
								<Table.Head class="text-xs">on map</Table.Head>
								<Table.Head class="text-xs">remaining</Table.Head>
								<Table.Head class="text-xs">cost (est.)</Table.Head>
								<Table.Head></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each country.regions as region (region.region)}
								{@const c = counts(region)}
								<Table.Row class="hover:bg-primary/5">
									<Table.Cell class="font-mono text-xs">{region.region}</Table.Cell>
									<Table.Cell>{num(c.osm)}</Table.Cell>
									<Table.Cell>{num(c.leads)}</Table.Cell>
									<Table.Cell>{num(c.unique)}</Table.Cell>
									<Table.Cell>{num(c.map_open)}</Table.Cell>
									<Table.Cell class="font-semibold">{num(c.remaining)}</Table.Cell>
									<Table.Cell>{cost(c.remaining)}</Table.Cell>
									<Table.Cell class="py-1">
										<Button
											variant="outline"
											size="xs"
											class="h-6 rounded-full font-normal"
											aria-expanded={expandedRegion === region.region}
											onclick={() => toggleRegion(region.region)}
										>
											{expandedRegion === region.region ? 'hide' : 'cities'}
										</Button>
									</Table.Cell>
								</Table.Row>
								{#if expandedRegion === region.region}
									<!-- City rows live in the SAME table, indented — a nested table
									     never lines its columns up with the parent's. -->
									{#each cities.slice(0, 40) as city (city.city)}
										{@const cc = counts(city)}
										<Table.Row class="bg-primary/4 text-xs hover:bg-primary/6">
											<Table.Cell class="py-1 pl-6">{city.city}</Table.Cell>
											<Table.Cell class="py-1">{num(cc.osm)}</Table.Cell>
											<Table.Cell class="py-1">{num(cc.leads)}</Table.Cell>
											<Table.Cell class="py-1">{num(cc.unique)}</Table.Cell>
											<Table.Cell class="py-1">{num(cc.map_open)}</Table.Cell>
											<Table.Cell class="py-1 font-semibold">{num(cc.remaining)}</Table.Cell>
											<Table.Cell class="py-1">{cost(cc.remaining)}</Table.Cell>
											<Table.Cell class="py-1"></Table.Cell>
										</Table.Row>
									{/each}
									{#if cities.length > 40}
										<Table.Row class="bg-primary/4 hover:bg-primary/4">
											<Table.Cell colspan={8} class="py-1 pl-6 text-[11px] text-muted-foreground">
												…and {cities.length - 40} smaller localities
											</Table.Cell>
										</Table.Row>
									{/if}
								{/if}
							{/each}
						</Table.Body>
					</Table.Root>
				</Card.Content>
			</Card.Root>
		{/each}
	</div>
{/if}
