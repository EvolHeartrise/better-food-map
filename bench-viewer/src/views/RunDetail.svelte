<script lang="ts">
	/**
	 * One run, in full.
	 *
	 * Four things live here that no other view can show:
	 *
	 * - **Provenance up top.** Provider and quantization decide what the score even
	 *   measures, so they sit in the header, with "unknown" spelled out rather than
	 *   left blank.
	 * - **The name-fidelity split.** The scorer matches names exactly, so one
	 *   dropped apostrophe costs a miss AND a hallucination. Splitting those apart
	 *   separates a fidelity bug (found it, wrote it differently) from a coverage
	 *   bug (never found it) — different fixes entirely.
	 * - **Rescore against current gold.** `report.json` is frozen at run time, so a
	 *   later gold edit silently invalidates it. Both numbers are shown.
	 * - **Page-discovery coverage.** The fetch sequence versus the pages the
	 *   snapshot holds. A model can score well while never opening the drinks page;
	 *   that is luck, and this is where it shows.
	 */
	import { fetchRunOrNull } from '../lib/api';
	import { count, duration, metricLabel, pct, timestamp, usd } from '../lib/format';
	import { router } from '../lib/state.svelte';
	import type { MetricKey } from '../lib/types';
	import Badge from '../components/Badge.svelte';
	import StatTile from '../components/StatTile.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import * as Table from '$lib/components/ui/table';
	import * as Tabs from '$lib/components/ui/tabs';

	const METRICS: MetricKey[] = [
		'item_recall',
		'item_precision',
		'tag_precision',
		'tag_recall',
		'optional_tag_precision',
		'optional_tag_recall',
		'price_accuracy',
		'description_accuracy',
		'warning_accuracy',
		'source_recall',
		'source_precision'
	];

	let tab = $state<'scores' | 'items' | 'navigation' | 'transcript' | 'passes'>('scores');
	let useCurrentGold = $state(false);

	let detail = $derived(await fetchRunOrNull(router.param('id')));

	let report = $derived(
		useCurrentGold ? (detail?.rescore.current ?? null) : (detail?.run.report ?? null)
	);

	/**
	 * Matched to whichever report is on screen. Rendering the run's frozen
	 * fidelity beside rescored dangerous-claims and mismatches put two different
	 * golds in one tab, unlabelled — in the exact feature that exists to tell them
	 * apart. Both variants come from the server, so the tested implementation is
	 * the one that runs.
	 */
	let fidelity = $derived(
		useCurrentGold ? (detail?.name_fidelity_current ?? null) : (detail?.name_fidelity ?? null)
	);

	let providerLabel = $derived.by(() => {
		const run = detail?.run;
		if (!run) return '';
		if (run.providers === null) return 'provider not recorded';
		if (run.providers.length === 0) return 'provider unreported';
		return run.providers
			.map(
				(provider) => `${provider} @ ${run.provider_quantizations?.[provider] ?? 'tier unknown'}`
			)
			.join(' + ');
	});
</script>

{#if !detail}
	<Card.Root size="sm">
		<Card.Content class="text-muted-foreground">No run selected.</Card.Content>
	</Card.Root>
{:else}
	{@const run = detail.run}
	<div class="flex flex-col gap-4">
		<Card.Root size="sm">
			<Card.Content>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div>
						<h1 class="text-lg">{run.model}</h1>
						<p class="text-[11px] text-muted-foreground">
							{run.task} · effort {run.effort ?? `default (${run.effort_default ?? 'unknown'})`} ·
							{run.backend} · {timestamp(run.started_at)}
						</p>
					</div>
					<Button variant="outline" size="xs" onclick={() => router.go('runs')}>← All runs</Button>
				</div>

				<div class="mt-2.5 mb-3.5 flex flex-wrap items-center gap-2">
					{#if run.status === 'failed'}
						<Badge tone="bad" label="failed: {run.failure_reason ?? 'unknown'}" />
					{/if}
					<Badge
						tone={run.providers === null || run.providers.length === 0 ? 'warn' : 'neutral'}
						label={providerLabel}
						title="A score is model × provider × quantization. Without a provider it cannot be attributed."
					/>
					<Badge
						tone={run.quantization_requested ? 'neutral' : 'warn'}
						label={run.quantization_requested
							? `pinned ${run.quantization_requested.join('+')}`
							: 'unpinned (cheapest-first routing)'}
						title="Unpinned means OpenRouter chose the endpoint, biased toward the most quantized. It does not mean unquantized."
					/>
					{#if detail.derived.rerouted}
						<Badge tone="bad" label="re-routed mid-run" />
					{/if}
					<Badge tone="neutral" label="gold {run.policy_version ?? 'unknown'}" />
					{#if detail.rescore.changed}
						<Badge
							tone="warn"
							label="gold has moved since this run"
							title="Scoring this submission against current gold gives different numbers."
						/>
					{/if}
				</div>

				<div class="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
					<StatTile
						label="Cost"
						value={usd(detail.derived.cost_usd)}
						note={detail.derived.cost_source ?? 'not reported'}
					/>
					<StatTile
						label="Perfect-cache cost"
						value={usd(run.price_cached)}
						note="counterfactual"
					/>
					<StatTile
						label="Agent time"
						value={duration(run.duration_ms)}
						note="excludes bench setup"
					/>
					<StatTile
						label="Tokens"
						value={count(run.total_tokens)}
						note="{pct(detail.derived.cache_hit_rate, 0)} prompt cached"
					/>
					<StatTile
						label="Tool calls"
						value={String(run.tool_calls ?? '—')}
						note="{run.submit_attempts ?? '—'} submit attempt(s)"
					/>
					<StatTile
						label="Unsafe tag claims"
						value={String(detail.derived.unsafe_tag_claims ?? '—')}
						note="dietary tags gold lacks"
						tone={(detail.derived.unsafe_tag_claims ?? 0) > 0 ? 'bad' : 'plain'}
					/>
				</div>
			</Card.Content>
		</Card.Root>

		<div class="flex flex-wrap items-center gap-3">
			<!-- `passes` appears only for a multi-pass run: on a single-pass run the
			     tab would open onto "this run had one pass", which is noise. -->
			<Tabs.Root value={tab} onValueChange={(next) => (tab = next as typeof tab)}>
				<Tabs.List class="h-8">
					{#each ['scores', 'items', 'navigation', 'transcript', ...(detail.run.passes.length > 1 ? ['passes'] : [])] as name (name)}
						<Tabs.Trigger value={name} class="px-2.5 text-xs">{name}</Tabs.Trigger>
					{/each}
				</Tabs.List>
			</Tabs.Root>
			{#if detail.rescore.current}
				<Label class="gap-1.5 text-xs font-normal text-muted-foreground">
					<Checkbox bind:checked={useCurrentGold} />
					Score against current gold ({detail.rescore.current_policy_version ?? '?'})
				</Label>
			{:else if detail.rescore.error}
				<span class="text-[11px] text-muted-foreground"
					>Rescore unavailable: {detail.rescore.error}</span
				>
			{/if}
		</div>

		{#if tab === 'scores'}
			<Card.Root size="sm">
				<Card.Content>
					{#if !report}
						<p class="text-muted-foreground">This run produced no report.</p>
					{:else}
						<Table.Root class="num-table text-[13px] tabular-nums">
							<Table.Header>
								<Table.Row class="hover:bg-transparent">
									<Table.Head class="text-xs">Metric</Table.Head>
									<Table.Head class="text-xs">As scored</Table.Head>
									{#if detail.rescore.current}<Table.Head class="text-xs">Current gold</Table.Head
										>{/if}
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each METRICS as metric (metric)}
									<Table.Row>
										<Table.Cell>{metricLabel(metric)}</Table.Cell>
										<Table.Cell>{pct(detail.run.report?.[metric] ?? null)}</Table.Cell>
										{#if detail.rescore.current}
											{@const now = detail.rescore.current[metric]}
											{@const before = detail.run.report?.[metric] ?? null}
											<Table.Cell
												class={before !== null && now !== before
													? 'font-semibold text-serious'
													: ''}>{pct(now)}</Table.Cell
											>
										{/if}
									</Table.Row>
								{/each}
								<Table.Row>
									<Table.Cell>Items (gold / candidate / matched)</Table.Cell>
									<Table.Cell
										>{report.gold_items} / {report.candidate_items} / {report.matched}</Table.Cell
									>
									{#if detail.rescore.current}
										<Table.Cell>
											{detail.rescore.current.gold_items} / {detail.rescore.current.candidate_items}
											/ {detail.rescore.current.matched}
										</Table.Cell>
									{/if}
								</Table.Row>
							</Table.Body>
						</Table.Root>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		{#if tab === 'passes'}
			<Card.Root size="sm">
				<Card.Header class="gap-0">
					<Card.Title>Passes</Card.Title>
				</Card.Header>
				<Card.Content>
					<Table.Root class="num-table text-[13px] tabular-nums">
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								<Table.Head class="text-xs">#</Table.Head>
								<Table.Head class="text-left text-xs">Role</Table.Head>
								<Table.Head class="text-left text-xs">Model</Table.Head>
								<Table.Head class="text-xs">Effort</Table.Head>
								<Table.Head class="text-xs">Status</Table.Head>
								<Table.Head class="text-xs">Duration</Table.Head>
								<Table.Head class="text-xs">Tool calls</Table.Head>
								<Table.Head class="text-xs">Tokens</Table.Head>
								<Table.Head class="text-xs">Cost</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each detail.run.passes as pass (pass.index)}
								<Table.Row>
									<Table.Cell>{pass.index}</Table.Cell>
									<Table.Cell class="text-left">{pass.role}</Table.Cell>
									<Table.Cell class="text-left">{pass.model}</Table.Cell>
									<Table.Cell>{pass.effort ?? '—'}</Table.Cell>
									<Table.Cell class={pass.status === 'failed' ? 'font-semibold text-critical' : ''}
										>{pass.status ?? '—'}</Table.Cell
									>
									<Table.Cell>{duration(pass.duration_ms)}</Table.Cell>
									<Table.Cell>{pass.tool_calls ?? '—'}</Table.Cell>
									<Table.Cell>{count(pass.total_tokens)}</Table.Cell>
									<Table.Cell>{usd(pass.price)}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
					<p class="mt-2 text-[11px] text-muted-foreground">
						The headline cost, token and duration figures above are the TOTAL across these passes —
						a two-pass setup is only comparable to a single-pass one if it is charged for both
						halves.
						<code class="rounded bg-muted px-1 font-mono">--max-tool-calls</code> applies PER pass, so
						each fresh agent gets the full budget.
					</p>
				</Card.Content>
			</Card.Root>

			{#if detail.pass_coverage.length > 0}
				<Card.Root size="sm">
					<Card.Header class="gap-0">
						<Card.Title>Page discovery, per pass</Card.Title>
					</Card.Header>
					<!-- The Navigation tab shows the whole-run UNION, which answers "did this setup
					     reach every page" but cannot tell a reviewer that recovered a whole menu
					     section from one that opened nothing. That distinction is the harness's
					     core hypothesis, so it gets its own table. -->
					<Card.Content>
						<Table.Root class="num-table text-[13px] tabular-nums">
							<Table.Header>
								<Table.Row class="hover:bg-transparent">
									<Table.Head class="text-xs">Pass</Table.Head>
									<Table.Head class="text-xs">Pages opened</Table.Head>
									<Table.Head class="text-xs">Of available</Table.Head>
									<Table.Head class="text-left text-xs">Opened only by this pass</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each detail.pass_coverage as entry (entry.pass)}
									{@const earlier = new Set(
										detail.pass_coverage
											.filter((other) => other.pass < entry.pass)
											.flatMap((other) => other.fetched_urls)
									)}
									{@const fresh = entry.fetched_urls.filter((url) => !earlier.has(url))}
									<Table.Row>
										<Table.Cell>{entry.pass}</Table.Cell>
										<Table.Cell>{entry.fetched_urls.length}</Table.Cell>
										<Table.Cell>{entry.coverage ? entry.coverage.available : '—'}</Table.Cell>
										<Table.Cell class="text-left whitespace-normal">
											{#if entry.pass === detail.pass_coverage[0].pass}
												<span class="text-muted-foreground">—</span>
											{:else if fresh.length === 0}
												<span class="text-muted-foreground">nothing new</span>
											{:else}
												<span class="font-semibold text-good">{fresh.length}</span>
												<span class="text-[11px] text-muted-foreground"
													>{fresh.slice(0, 3).join(', ')}{fresh.length > 3
														? ` +${fresh.length - 3} more`
														: ''}</span
												>
											{/if}
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</Card.Content>
				</Card.Root>
			{/if}

			<Card.Root size="sm">
				<Card.Header class="gap-0">
					<Card.Title>What the review pass changed</Card.Title>
				</Card.Header>
				<Card.Content>
					{#if !detail.review_effect}
						<!-- Two DIFFERENT reasons the effect is unavailable, and naming the wrong one
						     sends you looking for a file that is sitting right there. When pass 2
						     fails to submit, `report-pass1.json` DOES exist — only the final report
						     is missing. -->
						{#if detail.run.report_pass1 && !detail.run.report}
							<p class="text-muted-foreground">
								Pass 1 was scored, but the run produced no final result{detail.run.failure_reason
									? ` (${detail.run.failure_reason})`
									: ''} — so there is nothing to compare it against. Pass 1's own score is in
								<code class="rounded bg-muted px-1 font-mono text-xs">report-pass1.json</code>.
							</p>
						{:else}
							<p class="text-muted-foreground">
								No pass-1 score was recorded for this run, so the review pass's effect cannot be
								separated from the final result.
							</p>
						{/if}
					{:else}
						{@const effect = detail.review_effect}
						<Table.Root class="num-table text-[13px] tabular-nums">
							<Table.Header>
								<Table.Row class="hover:bg-transparent">
									<Table.Head class="text-xs">Metric</Table.Head>
									<Table.Head class="text-xs">After pass 1</Table.Head>
									<Table.Head class="text-xs">Final</Table.Head>
									<Table.Head class="text-xs">Change</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each METRICS as metric (metric)}
									{@const m = effect.metrics[metric]}
									{#if m}
										<Table.Row>
											<Table.Cell>{metricLabel(metric)}</Table.Cell>
											<Table.Cell>{pct(m.before)}</Table.Cell>
											<Table.Cell>{pct(m.after)}</Table.Cell>
											<!-- Signed and per metric, never a net verdict: a reviewer that
											     recovers a missed page while renaming items has improved recall
											     AND damaged precision, and one badge would erase the trade.
											     Colour carries the DIRECTION only — magnitude stays in the
											     number, because +0.4pp and +40pp must not read alike. -->
											<Table.Cell
												class={m.delta > 0
													? 'font-semibold text-good'
													: m.delta < 0
														? 'font-semibold text-critical'
														: 'text-muted-foreground'}
											>
												{m.delta === 0
													? '—'
													: `${m.delta > 0 ? '+' : ''}${(m.delta * 100).toFixed(1)}pp`}
											</Table.Cell>
										</Table.Row>
									{/if}
								{/each}
								<Table.Row>
									<Table.Cell>Items matched</Table.Cell>
									<Table.Cell>{effect.matched.before}</Table.Cell>
									<Table.Cell>{effect.matched.after}</Table.Cell>
									<Table.Cell class="text-muted-foreground">—</Table.Cell>
								</Table.Row>
								<Table.Row>
									<Table.Cell>Hallucinated</Table.Cell>
									<Table.Cell>{effect.hallucinated.before}</Table.Cell>
									<Table.Cell>{effect.hallucinated.after}</Table.Cell>
									<Table.Cell class="text-muted-foreground">—</Table.Cell>
								</Table.Row>
							</Table.Body>
						</Table.Root>

						<div class="mt-3 flex flex-wrap items-start gap-6">
							<div class="min-w-0 flex-[1_1_260px]">
								<h3 class="mb-1 text-xs font-semibold text-muted-foreground">
									Recovered by the review pass ({effect.newly_found.length})
								</h3>
								{#if effect.newly_found.length === 0}
									<p class="text-[11px] text-muted-foreground">Nothing pass 1 missed was found.</p>
								{:else}
									<ul class="max-h-60 list-disc overflow-y-auto pl-4.5 text-[11px]">
										{#each effect.newly_found as name (name)}<li>{name}</li>{/each}
									</ul>
								{/if}
							</div>
							<div class="min-w-0 flex-[1_1_260px]">
								<!-- The regression direction, called out separately: a review pass that
								     nets +2pp while DROPPING items pass 1 had is a different result from
								     one that only adds, and a ratio cannot tell them apart. -->
								<h3 class="mb-1 text-xs font-semibold text-serious">
									Lost by the review pass ({effect.newly_missed.length})
								</h3>
								{#if effect.newly_missed.length === 0}
									<p class="text-[11px] text-muted-foreground">Nothing pass 1 found was lost.</p>
								{:else}
									<ul class="max-h-60 list-disc overflow-y-auto pl-4.5 text-[11px]">
										{#each effect.newly_missed as name (name)}<li>{name}</li>{/each}
									</ul>
								{/if}
							</div>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		{#if tab === 'items' && report}
			<Card.Root size="sm">
				<Card.Header class="gap-0">
					<Card.Title>
						Name fidelity
						<span class="text-[11px] font-normal text-muted-foreground"
							>· against {useCurrentGold
								? `current gold (${detail.rescore.current_policy_version ?? '?'})`
								: `gold as scored (${run.policy_version ?? 'unknown'})`}</span
						>
					</Card.Title>
					<Card.Description class="text-xs">
						The scorer matches names exactly, so a rewritten name costs one miss AND one
						hallucination. These are the same failures, split by what actually went wrong.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					{#if fidelity && fidelity.renamed.length > 0}
						<h3 class="mb-1 text-[13px] text-muted-foreground">
							Found but renamed ({fidelity.renamed.length})
						</h3>
						<Table.Root class="num-table text-[13px] tabular-nums">
							<Table.Header>
								<Table.Row class="hover:bg-transparent">
									<Table.Head class="text-xs">Gold</Table.Head>
									<Table.Head class="text-left text-xs">Candidate</Table.Head>
									<Table.Head class="text-xs">Edit distance</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each fidelity.renamed as pair, index (index)}
									<Table.Row>
										<Table.Cell>{pair.gold}</Table.Cell>
										<Table.Cell class="text-left">{pair.candidate}</Table.Cell>
										<Table.Cell>{pair.distance}</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}

					<div class="mt-3 grid grid-cols-1 gap-6 md:grid-cols-2">
						<div>
							<h3 class="text-[13px] text-muted-foreground">
								Never found ({detail.name_fidelity?.true_misses.length ??
									report.missed_items.length})
							</h3>
							<ul
								class="mt-1.5 max-h-80 list-disc overflow-y-auto pl-4.5 text-xs [&>li]:mb-0.5 [&>li]:break-words"
							>
								{#each fidelity?.true_misses ?? report.missed_items as item, index (index)}
									<li>{item}</li>
								{:else}
									<li class="text-muted-foreground">None</li>
								{/each}
							</ul>
						</div>
						<div>
							<h3 class="text-[13px] text-muted-foreground">
								Invented ({detail.name_fidelity?.true_hallucinations.length ??
									report.hallucinated_items.length})
							</h3>
							<ul
								class="mt-1.5 max-h-80 list-disc overflow-y-auto pl-4.5 text-xs [&>li]:mb-0.5 [&>li]:break-words"
							>
								{#each fidelity?.true_hallucinations ?? report.hallucinated_items as item, index (index)}
									<li>{item}</li>
								{:else}
									<li class="text-muted-foreground">None</li>
								{/each}
							</ul>
						</div>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root size="sm">
				<Card.Header class="gap-0">
					<Card.Title>Dangerous claims</Card.Title>
					<Card.Description class="text-xs">
						Dietary tags the candidate asserted that gold does not support. A free-of claim the
						source never made is the failure mode the data policy cares most about.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					{#if report.tag_false_positives.length === 0}
						<p class="text-muted-foreground">None.</p>
					{:else}
						<Table.Root class="text-[13px]">
							<Table.Header>
								<Table.Row class="hover:bg-transparent">
									<Table.Head class="text-xs">Item</Table.Head>
									<Table.Head class="text-xs">Tag</Table.Head>
									<Table.Head class="text-xs">Asserted</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each report.tag_false_positives as claim, index (index)}
									<Table.Row>
										<Table.Cell>{claim.item}</Table.Cell>
										<Table.Cell>{claim.tag}</Table.Cell>
										<Table.Cell>
											{claim.implied_by ? `implied by ${claim.implied_by}` : 'directly'}
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Card.Content>
			</Card.Root>

			{#if report.price_mismatches?.length || report.description_mismatches?.length}
				<Card.Root size="sm">
					<Card.Header class="gap-0">
						<Card.Title>Field mismatches</Card.Title>
					</Card.Header>
					<Card.Content>
						{#if report.price_mismatches?.length}
							<h3 class="mb-1 text-[13px] text-muted-foreground">
								Price ({report.price_mismatches.length})
							</h3>
							<Table.Root class="num-table text-[13px] tabular-nums">
								<Table.Header>
									<Table.Row class="hover:bg-transparent">
										<Table.Head class="text-xs">Item</Table.Head>
										<Table.Head class="text-xs">Gold</Table.Head>
										<Table.Head class="text-xs">Candidate</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each report.price_mismatches as mismatch, index (index)}
										<Table.Row>
											<Table.Cell>{mismatch.item}</Table.Cell>
											<Table.Cell>{mismatch.gold ?? '—'}</Table.Cell>
											<Table.Cell>{mismatch.candidate ?? '—'}</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						{/if}
						{#if report.description_mismatches?.length}
							<h3 class="mt-3 mb-1 text-[13px] text-muted-foreground">
								Description ({report.description_mismatches.length})
							</h3>
							{#each report.description_mismatches as mismatch, index (index)}
								<div class="border-t border-gridline py-2 text-xs">
									<div class="mb-0.5 font-semibold">{mismatch.item}</div>
									<div class="mb-0.5 text-muted-foreground">
										<span class="inline-block min-w-[42px] text-[11px] text-muted-foreground/70"
											>gold</span
										>{mismatch.gold ?? '(null)'}
									</div>
									<div class="mb-0.5 text-muted-foreground">
										<span class="inline-block min-w-[42px] text-[11px] text-muted-foreground/70"
											>cand</span
										>{mismatch.candidate ?? '(null)'}
									</div>
								</div>
							{/each}
						{/if}
					</Card.Content>
				</Card.Root>
			{/if}
		{/if}

		{#if tab === 'navigation'}
			<Card.Root size="sm">
				<Card.Header class="gap-0">
					<Card.Title>Page discovery</Card.Title>
					<Card.Description class="text-xs">
						What the model opened, against what the snapshot holds. The scorer cannot see this: a
						run can score well on items while never opening a whole menu page.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					{#if !detail.page_coverage}
						<p class="text-muted-foreground">No page manifest for this task.</p>
					{:else}
						{@const coverage = detail.page_coverage}
						<div class="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
							<StatTile
								label="Pages opened"
								value="{coverage.visited}/{coverage.available}"
								note={pct(coverage.ratio, 0)}
							/>
							<StatTile
								label="Never opened"
								value={String(coverage.unvisited.length)}
								note="the blind-spot list"
								tone={coverage.unvisited.length > 0 ? 'warn' : 'plain'}
							/>
							<StatTile
								label="Off-manifest fetches"
								value={String(coverage.off_manifest.length)}
								note="APIs and assets — not a fault"
							/>
						</div>

						{#if coverage.unvisited.length > 0}
							<h3 class="mt-3.5 mb-1 text-[13px] text-muted-foreground">Pages never opened</h3>
							<!--
								The whole list, not a "menu pages" subset. Recognizing a menu page
								from its URL needs world knowledge a word list does not have — New
								York Fries serves its menu from /fries, /poutine, /premiumdogs and
								/dips — so a filtered list would hide exactly the misses worth
								seeing. Menu-word URLs are sorted FIRST as a reading hint; the rest
								still matter, so read past them.
							-->
							<p class="text-[11px] text-muted-foreground">
								Every recorded page this run never fetched, likely-relevant URLs first. Not all of
								these are faults — a venue's snapshot includes its careers and privacy pages.
							</p>
							<ul
								class="mt-1.5 max-h-80 list-disc overflow-y-auto pl-4.5 font-mono text-xs [&>li]:mb-0.5 [&>li]:break-all"
							>
								{#each coverage.unvisited as url (url)}
									<li>{url}</li>
								{/each}
							</ul>
						{/if}

						<h3 class="mt-3.5 mb-1 text-[13px] text-muted-foreground">Fetch order</h3>
						<ol
							class="mt-1.5 max-h-80 list-decimal overflow-y-auto pl-4.5 font-mono text-xs [&>li]:mb-0.5 [&>li]:break-all"
						>
							{#each detail.fetched_urls as url (url)}
								<li>{url}</li>
							{/each}
						</ol>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		{#if tab === 'transcript'}
			<Card.Root size="sm">
				<Card.Header class="gap-0">
					<Card.Title>Turn timeline</Card.Title>
				</Card.Header>
				<Card.Content>
					<Table.Root class="num-table text-[13px] tabular-nums">
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								<Table.Head class="text-xs">Event</Table.Head>
								<Table.Head class="text-xs">Δ</Table.Head>
								<Table.Head class="text-left text-xs">Detail</Table.Head>
								<Table.Head class="text-xs">Prompt</Table.Head>
								<Table.Head class="text-xs">Cached</Table.Head>
								<Table.Head class="text-xs">Completion</Table.Head>
								<Table.Head class="text-xs">Reasoning</Table.Head>
								<Table.Head class="text-xs">Cost</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each detail.timeline as event, index (index)}
								<Table.Row>
									<Table.Cell>{event.type}</Table.Cell>
									<Table.Cell>{event.delta_ms === null ? '—' : duration(event.delta_ms)}</Table.Cell
									>
									<Table.Cell class="max-w-[420px] truncate text-left font-mono text-xs">
										{event.url ?? event.tool ?? event.provider ?? ''}
									</Table.Cell>
									<Table.Cell>{count(event.prompt_tokens ?? null)}</Table.Cell>
									<Table.Cell>{count(event.cached_tokens ?? null)}</Table.Cell>
									<Table.Cell>{count(event.completion_tokens ?? null)}</Table.Cell>
									<Table.Cell>{count(event.reasoning_tokens ?? null)}</Table.Cell>
									<Table.Cell>{usd(event.cost ?? null)}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</Card.Content>
			</Card.Root>
		{/if}
	</div>
{/if}
