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
	<div class="card">
		<h2>Data sources</h2>
		<p class="bad">{summary.reason}</p>
	</div>
{:else if summary.sources}
	{@const s = summary.sources}
	<div class="stack">
		<div class="card">
			<h2>Eateries by source</h2>
			<div class="row wrap tiles">
				<div class="tile">
					<span class="k">OSM staging</span>
					<span class="v">{num(s.osm.total)}</span>
					<span class="d"
						>{num(s.osm.named)} named · {num(s.osm.with_website)} with website · {num(
							s.osm.matched_overture
						)} Overture-matched</span
					>
				</div>
				<div class="tile">
					<span class="k">Overture leads</span>
					<span class="v">{num(s.overture_leads.total)}</span>
					<span class="d"
						>{num(s.overture_leads.with_website)} with website · release {s.overture_leads
							.release ?? '—'} · not near any OSM POI</span
					>
				</div>
				<div class="tile">
					<span class="k">On the map</span>
					<span class="v">{num(s.map.open)}</span>
					<span class="d">
						{s.map.closed} closed ·
						{#if s.map.mirror_found}
							mirror {staleDays(s.map.mirror_mtime)}d old
						{:else}
							no local mirror — run <code>bun run db:pull</code>
						{/if}
					</span>
				</div>
			</div>
			<p class="muted small">{summary.method}</p>
		</div>

		<div class="card">
			<h2>Ingestion cost basis</h2>
			<div class="row wrap basis">
				<label class="small">
					configuration
					<select bind:value={basisKey}>
						{#each costBases as base (base.key)}
							<option value={base.key}>{base.label} (n={base.n}, {usd(base.real ?? 0)}/run)</option>
						{/each}
					</select>
				</label>
				<label class="small chk">
					<input type="checkbox" bind:checked={useCached} disabled={basis?.cached === null} />
					cached-prefix cost
				</label>
				<label class="small">
					overhead ×
					<input class="num-in" type="number" min="1" step="0.5" bind:value={overhead} />
				</label>
				<span class="small stat">
					= {perMenu === null ? '—' : usd(perMenu)}/menu
				</span>
			</div>
			<p class="muted small">
				Mean bench run cost for the picked configuration × overhead (discovery, verification,
				retries). Chains share one menu across branches, so per-venue cost over-counts chain-heavy
				areas — treat totals as an upper bound.
			</p>
		</div>

		{#each summary.countries ?? [] as country (country.country)}
			<div class="card">
				<div class="spread">
					<h2>{country.country} — by province</h2>
					<label class="small chk toggle">
						<input type="checkbox" bind:checked={webOnly} />
						with website only
					</label>
				</div>
				{#if webOnly}
					<p class="muted small">
						All columns restricted to venues with a website on file — the directly menu-researchable
						subset. Venues without one need site discovery first.
					</p>
				{/if}
				<div class="scroll">
					<table>
						<thead>
							<tr>
								<th>region</th>
								<th class="num">OSM</th>
								<th class="num">leads</th>
								<th class="num">unique (est.)</th>
								<th class="num">on map</th>
								<th class="num">remaining</th>
								<th class="num">cost (est.)</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each country.regions as region (region.region)}
								{@const c = counts(region)}
								<tr>
									<td class="mono">{region.region}</td>
									<td class="num">{num(c.osm)}</td>
									<td class="num">{num(c.leads)}</td>
									<td class="num">{num(c.unique)}</td>
									<td class="num">{num(c.map_open)}</td>
									<td class="num strong">{num(c.remaining)}</td>
									<td class="num">{cost(c.remaining)}</td>
									<td>
										<button class="chip" onclick={() => toggleRegion(region.region)}>
											{expandedRegion === region.region ? 'hide' : 'cities'}
										</button>
									</td>
								</tr>
								{#if expandedRegion === region.region}
									<tr>
										<td colspan="8" class="citycell">
											<table class="inner">
												<tbody>
													{#each cities.slice(0, 40) as city (city.city)}
														{@const c = counts(city)}
														<tr>
															<td>{city.city}</td>
															<td class="num">{num(c.osm)}</td>
															<td class="num">{num(c.leads)}</td>
															<td class="num">{num(c.unique)}</td>
															<td class="num">{num(c.map_open)}</td>
															<td class="num strong">{num(c.remaining)}</td>
															<td class="num">{cost(c.remaining)}</td>
															<td></td>
														</tr>
													{/each}
													{#if cities.length > 40}
														<tr>
															<td colspan="8" class="muted small">
																…and {cities.length - 40} smaller localities
															</td>
														</tr>
													{/if}
												</tbody>
											</table>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.tiles {
		gap: 12px;
	}

	.tile {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 8px 14px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 180px;
	}

	.k {
		font-size: 11px;
		color: var(--text-secondary);
	}

	.v {
		font-size: 22px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}

	.d {
		font-size: 11px;
		color: var(--text-secondary);
	}

	.basis {
		gap: 14px;
		align-items: center;
	}

	.chk {
		display: inline-flex;
		gap: 4px;
		align-items: center;
	}

	.spread {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.num-in {
		width: 60px;
	}

	.stat {
		font-weight: 600;
	}

	select,
	input {
		font: inherit;
		font-size: 12px;
		padding: 3px 6px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-1);
		color: var(--text-primary);
	}

	.scroll {
		overflow-x: auto;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.strong {
		font-weight: 600;
	}

	.mono {
		font-family: var(--mono);
	}

	.citycell {
		padding: 0 0 8px 24px;
	}

	.inner {
		font-size: 12px;
	}

	.small {
		font-size: 11px;
	}

	.bad {
		color: var(--critical);
	}

	code {
		font-family: var(--mono);
		font-size: 11px;
	}
</style>
