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
	import { fetchOverview, fetchRunOrNull, removeBlacklistEntry } from '../lib/api';
	import { count, duration, metricLabel, pct, timestamp, usd } from '../lib/format';
	import { filters, refreshData, router } from '../lib/state.svelte';
	import type { MetricKey } from '../lib/types';
	import Badge from '../components/Badge.svelte';
	import BlacklistForm from '../components/BlacklistForm.svelte';
	import StatTile from '../components/StatTile.svelte';

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
	let retiring = $state(false);
	let restoring = $state(false);
	let editError = $state<string | null>(null);

	let detail = $derived(await fetchRunOrNull(router.param('id'), filters.revision));
	let overview = $derived(await fetchOverview(filters.revision));
	let canEdit = $derived(overview.blacklist.writable);

	/**
	 * Guarded against a second click while in flight: the server 404s a repeat
	 * DELETE, so a double-click would remove the verdict and then paint "no entry
	 * matching …" in red — reading as a failure when it in fact succeeded.
	 */
	async function restore(): Promise<void> {
		const entry = detail?.blacklist;
		if (!entry || restoring) return;
		restoring = true;
		editError = null;
		try {
			await removeBlacklistEntry({
				model: entry.model,
				effort: entry.effort === 'all' ? '*' : entry.effort,
				backend: entry.backend ?? undefined
			});
			refreshData();
		} catch (caught) {
			editError = caught instanceof Error ? caught.message : String(caught);
		} finally {
			restoring = false;
		}
	}

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
	<div class="card"><p class="muted">No run selected.</p></div>
{:else}
	{@const run = detail.run}
	<div class="stack">
		<div class="card">
			<div class="spread">
				<div>
					<h1>{run.model}</h1>
					<p class="muted small">
						{run.task} · effort {run.effort ?? `default (${run.effort_default ?? 'unknown'})`} ·
						{run.backend} · {timestamp(run.started_at)}
					</p>
				</div>
				<button class="chip" onclick={() => router.go('runs')}>← All runs</button>
			</div>

			<div class="row wrap badges">
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
				{#if detail.blacklist}
					<Badge
						tone="neutral"
						label="⊘ blacklisted config"
						title={`${detail.blacklist.label} — ${detail.blacklist.reason} (added ${detail.blacklist.added})`}
					/>
				{/if}
			</div>

			<!--
				The verdict, in full, on the page that holds the evidence for it. This
				run's numbers are not invalidated by it — they are very likely part of
				what produced it — so it reads as a note, not as a failure.
			-->
			{#if detail.blacklist}
				<div class="verdict">
					<div class="row wrap vhead">
						<strong class="small">Configuration retired: {detail.blacklist.label}</strong>
						<span class="muted small">added {detail.blacklist.added}</span>
						{#if canEdit}
							<button
								class="chip"
								disabled={restoring}
								title="Drop this verdict — bench:run will buy this configuration again."
								onclick={restore}>{restoring ? 'Removing…' : 'Un-blacklist'}</button
							>
						{/if}
					</div>
					<p class="vreason">{detail.blacklist.reason}</p>
					{#if detail.blacklist.evidence}
						<p class="muted small">evidence: {detail.blacklist.evidence}</p>
					{/if}
				</div>
			{:else if canEdit}
				<div class="retire">
					{#if retiring}
						<BlacklistForm
							model={run.model}
							lockModel
							efforts={overview.facets.efforts}
							effort={run.effort ?? 'default'}
							backend={run.backend}
							onsaved={() => (retiring = false)}
							oncancel={() => (retiring = false)}
						/>
					{:else}
						<button
							class="chip"
							title="Record a verdict against this model/effort/backend so it is never re-purchased."
							onclick={() => (retiring = true)}>⊘ Blacklist this configuration</button
						>
					{/if}
				</div>
			{/if}

			{#if editError}
				<p class="error-line">{editError}</p>
			{/if}

			<div class="tiles">
				<StatTile
					label="Cost"
					value={usd(detail.derived.cost_usd)}
					note={detail.derived.cost_source ?? 'not reported'}
				/>
				<StatTile label="Perfect-cache cost" value={usd(run.price_cached)} note="counterfactual" />
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
		</div>

		<div class="row wrap tabs">
			<!-- `passes` appears only for a multi-pass run: on a single-pass run the
			     tab would open onto "this run had one pass", which is noise. -->
			{#each ['scores', 'items', 'navigation', 'transcript', ...(detail.run.passes.length > 1 ? ['passes'] : [])] as name (name)}
				<button class="chip" aria-pressed={tab === name} onclick={() => (tab = name as typeof tab)}
					>{name}</button
				>
			{/each}
			{#if detail.rescore.current}
				<label class="rescore">
					<input type="checkbox" bind:checked={useCurrentGold} />
					Score against current gold ({detail.rescore.current_policy_version ?? '?'})
				</label>
			{:else if detail.rescore.error}
				<span class="muted small">Rescore unavailable: {detail.rescore.error}</span>
			{/if}
		</div>

		{#if tab === 'scores'}
			<div class="card">
				{#if !report}
					<p class="muted">This run produced no report.</p>
				{:else}
					<div class="scroll-x">
						<table>
							<thead>
								<tr>
									<th class="left">Metric</th>
									<th>As scored</th>
									{#if detail.rescore.current}<th>Current gold</th>{/if}
								</tr>
							</thead>
							<tbody>
								{#each METRICS as metric (metric)}
									<tr>
										<td class="left">{metricLabel(metric)}</td>
										<td>{pct(detail.run.report?.[metric] ?? null)}</td>
										{#if detail.rescore.current}
											{@const now = detail.rescore.current[metric]}
											{@const before = detail.run.report?.[metric] ?? null}
											<td class:moved={before !== null && now !== before}>{pct(now)}</td>
										{/if}
									</tr>
								{/each}
								<tr>
									<td class="left">Items (gold / candidate / matched)</td>
									<td>{report.gold_items} / {report.candidate_items} / {report.matched}</td>
									{#if detail.rescore.current}
										<td>
											{detail.rescore.current.gold_items} / {detail.rescore.current.candidate_items}
											/ {detail.rescore.current.matched}
										</td>
									{/if}
								</tr>
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		{/if}

		{#if tab === 'passes'}
			<div class="card">
				<h2>Passes</h2>
				<div class="scroll-x">
					<table>
						<thead>
							<tr>
								<th class="left">#</th>
								<th class="left">Role</th>
								<th class="left">Model</th>
								<th>Effort</th>
								<th>Status</th>
								<th>Duration</th>
								<th>Tool calls</th>
								<th>Tokens</th>
								<th>Cost</th>
							</tr>
						</thead>
						<tbody>
							{#each detail.run.passes as pass (pass.index)}
								<tr>
									<td class="left">{pass.index}</td>
									<td class="left">{pass.role}</td>
									<td class="left">{pass.model}</td>
									<td>{pass.effort ?? '—'}</td>
									<td class:bad={pass.status === 'failed'}>{pass.status}</td>
									<td>{duration(pass.duration_ms)}</td>
									<td>{pass.tool_calls ?? '—'}</td>
									<td>{count(pass.total_tokens)}</td>
									<td>{usd(pass.price)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="muted small">
					The headline cost, token and duration figures above are the TOTAL across these passes — a
					two-pass setup is only comparable to a single-pass one if it is charged for both halves.
				</p>
			</div>

			<div class="card">
				<h2>What the review pass changed</h2>
				{#if !detail.review_effect}
					<p class="muted">
						No pass-1 score was recorded for this run, so the review pass's effect cannot be
						separated from the final result.
					</p>
				{:else}
					{@const effect = detail.review_effect}
					<div class="scroll-x">
						<table>
							<thead>
								<tr>
									<th class="left">Metric</th>
									<th>After pass 1</th>
									<th>Final</th>
									<th>Change</th>
								</tr>
							</thead>
							<tbody>
								{#each METRICS as metric (metric)}
									{@const m = effect.metrics[metric]}
									{#if m}
										<tr>
											<td class="left">{metricLabel(metric)}</td>
											<td>{pct(m.before)}</td>
											<td>{pct(m.after)}</td>
											<!-- Signed and per metric, never a net verdict: a reviewer that
											     recovers a missed page while renaming items has improved recall
											     AND damaged precision, and one badge would erase the trade. -->
											<td
												class:good={m.delta > 0}
												class:bad={m.delta < 0}
												class:muted={m.delta === 0}
											>
												{m.delta === 0
													? '—'
													: `${m.delta > 0 ? '+' : ''}${(m.delta * 100).toFixed(1)}pp`}
											</td>
										</tr>
									{/if}
								{/each}
								<tr>
									<td class="left">Items matched</td>
									<td>{effect.matched.before}</td>
									<td>{effect.matched.after}</td>
									<td class="muted">—</td>
								</tr>
								<tr>
									<td class="left">Hallucinated</td>
									<td>{effect.hallucinated.before}</td>
									<td>{effect.hallucinated.after}</td>
									<td class="muted">—</td>
								</tr>
							</tbody>
						</table>
					</div>

					<div class="row wrap churn">
						<div>
							<h3>Recovered by the review pass ({effect.newly_found.length})</h3>
							{#if effect.newly_found.length === 0}
								<p class="muted small">Nothing pass 1 missed was found.</p>
							{:else}
								<ul class="small">
									{#each effect.newly_found as name (name)}<li>{name}</li>{/each}
								</ul>
							{/if}
						</div>
						<div>
							<!-- The regression direction, called out separately: a review pass that
							     nets +2pp while DROPPING items pass 1 had is a different result from
							     one that only adds, and a ratio cannot tell them apart. -->
							<h3 class="warn">Lost by the review pass ({effect.newly_missed.length})</h3>
							{#if effect.newly_missed.length === 0}
								<p class="muted small">Nothing pass 1 found was lost.</p>
							{:else}
								<ul class="small">
									{#each effect.newly_missed as name (name)}<li>{name}</li>{/each}
								</ul>
							{/if}
						</div>
					</div>
				{/if}
			</div>
		{/if}

		{#if tab === 'items' && report}
			<div class="card">
				<h2>
					Name fidelity
					<span class="muted small"
						>· against {useCurrentGold
							? `current gold (${detail.rescore.current_policy_version ?? '?'})`
							: `gold as scored (${run.policy_version ?? 'unknown'})`}</span
					>
				</h2>
				<p class="muted small">
					The scorer matches names exactly, so a rewritten name costs one miss AND one
					hallucination. These are the same failures, split by what actually went wrong.
				</p>

				{#if fidelity && fidelity.renamed.length > 0}
					<h3>Found but renamed ({fidelity.renamed.length})</h3>
					<div class="scroll-x">
						<table>
							<thead>
								<tr
									><th class="left">Gold</th><th class="left">Candidate</th><th>Edit distance</th
									></tr
								>
							</thead>
							<tbody>
								{#each fidelity.renamed as pair, index (index)}
									<tr>
										<td class="left">{pair.gold}</td>
										<td class="left">{pair.candidate}</td>
										<td>{pair.distance}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}

				<div class="split">
					<div>
						<h3>
							Never found ({detail.name_fidelity?.true_misses.length ?? report.missed_items.length})
						</h3>
						<ul class="list">
							{#each fidelity?.true_misses ?? report.missed_items as item, index (index)}
								<li>{item}</li>
							{:else}
								<li class="muted">None</li>
							{/each}
						</ul>
					</div>
					<div>
						<h3>
							Invented ({detail.name_fidelity?.true_hallucinations.length ??
								report.hallucinated_items.length})
						</h3>
						<ul class="list">
							{#each fidelity?.true_hallucinations ?? report.hallucinated_items as item, index (index)}
								<li>{item}</li>
							{:else}
								<li class="muted">None</li>
							{/each}
						</ul>
					</div>
				</div>
			</div>

			<div class="card">
				<h2>Dangerous claims</h2>
				<p class="muted small">
					Dietary tags the candidate asserted that gold does not support. A free-of claim the source
					never made is the failure mode the data policy cares most about.
				</p>
				{#if report.tag_false_positives.length === 0}
					<p class="muted">None.</p>
				{:else}
					<div class="scroll-x">
						<table>
							<thead>
								<tr
									><th class="left">Item</th><th class="left">Tag</th><th class="left">Asserted</th
									></tr
								>
							</thead>
							<tbody>
								{#each report.tag_false_positives as claim, index (index)}
									<tr>
										<td class="left">{claim.item}</td>
										<td class="left">{claim.tag}</td>
										<td class="left">
											{claim.implied_by ? `implied by ${claim.implied_by}` : 'directly'}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>

			{#if report.price_mismatches?.length || report.description_mismatches?.length}
				<div class="card">
					<h2>Field mismatches</h2>
					{#if report.price_mismatches?.length}
						<h3>Price ({report.price_mismatches.length})</h3>
						<div class="scroll-x">
							<table>
								<thead>
									<tr><th class="left">Item</th><th>Gold</th><th>Candidate</th></tr>
								</thead>
								<tbody>
									{#each report.price_mismatches as mismatch, index (index)}
										<tr>
											<td class="left">{mismatch.item}</td>
											<td>{mismatch.gold ?? '—'}</td>
											<td>{mismatch.candidate ?? '—'}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
					{#if report.description_mismatches?.length}
						<h3>Description ({report.description_mismatches.length})</h3>
						{#each report.description_mismatches as mismatch, index (index)}
							<div class="diff">
								<div class="diff-item">{mismatch.item}</div>
								<div class="diff-side">
									<span class="tag">gold</span>{mismatch.gold ?? '(null)'}
								</div>
								<div class="diff-side">
									<span class="tag">cand</span>{mismatch.candidate ?? '(null)'}
								</div>
							</div>
						{/each}
					{/if}
				</div>
			{/if}
		{/if}

		{#if tab === 'navigation'}
			<div class="card">
				<h2>Page discovery</h2>
				<p class="muted small">
					What the model opened, against what the snapshot holds. The scorer cannot see this: a run
					can score well on items while never opening a whole menu page.
				</p>
				{#if !detail.page_coverage}
					<p class="muted">No page manifest for this task.</p>
				{:else}
					{@const coverage = detail.page_coverage}
					<div class="tiles">
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
						<h3>Pages never opened</h3>
						<!--
							The whole list, not a "menu pages" subset. Recognizing a menu page
							from its URL needs world knowledge a word list does not have — New
							York Fries serves its menu from /fries, /poutine, /premiumdogs and
							/dips — so a filtered list would hide exactly the misses worth
							seeing. Menu-word URLs are sorted FIRST as a reading hint; the rest
							still matter, so read past them.
						-->
						<p class="muted small">
							Every recorded page this run never fetched, likely-relevant URLs first. Not all of
							these are faults — a venue's snapshot includes its careers and privacy pages.
						</p>
						<ul class="list mono">
							{#each coverage.unvisited as url (url)}
								<li>{url}</li>
							{/each}
						</ul>
					{/if}

					<h3>Fetch order</h3>
					<ol class="list mono">
						{#each detail.fetched_urls as url (url)}
							<li>{url}</li>
						{/each}
					</ol>
				{/if}
			</div>
		{/if}

		{#if tab === 'transcript'}
			<div class="card">
				<h2>Turn timeline</h2>
				<div class="scroll-x">
					<table>
						<thead>
							<tr>
								<th class="left">Event</th>
								<th>Δ</th>
								<th class="left">Detail</th>
								<th>Prompt</th>
								<th>Cached</th>
								<th>Completion</th>
								<th>Reasoning</th>
								<th>Cost</th>
							</tr>
						</thead>
						<tbody>
							{#each detail.timeline as event, index (index)}
								<tr>
									<td class="left">{event.type}</td>
									<td>{event.delta_ms === null ? '—' : duration(event.delta_ms)}</td>
									<td class="left detail-cell mono">
										{event.url ?? event.tool ?? event.provider ?? ''}
									</td>
									<td>{count(event.prompt_tokens ?? null)}</td>
									<td>{count(event.cached_tokens ?? null)}</td>
									<td>{count(event.completion_tokens ?? null)}</td>
									<td>{count(event.reasoning_tokens ?? null)}</td>
									<td>{usd(event.cost ?? null)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.verdict {
		margin-top: 10px;
		border-left: 2px solid var(--border);
		padding-left: 10px;
	}

	.vhead {
		gap: 8px;
		align-items: center;
	}

	.vreason {
		margin: 2px 0 0;
		font-size: 12px;
		color: var(--text-secondary);
		max-width: 80ch;
	}

	.retire {
		margin-top: 10px;
	}

	.error-line {
		color: var(--critical);
		font-size: 12px;
		margin: 8px 0 0;
	}

	.small {
		font-size: 11px;
	}

	.badges {
		margin: 10px 0 14px;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 10px;
	}

	.tabs {
		gap: 6px;
	}

	.rescore {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--text-secondary);
		margin-left: 8px;
	}

	.split {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 24px;
		margin-top: 12px;
	}

	@media (max-width: 800px) {
		.split {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.list {
		margin: 6px 0 0;
		padding-left: 18px;
		font-size: 12px;
		max-height: 320px;
		overflow-y: auto;
	}

	.list li {
		margin-bottom: 2px;
		word-break: break-word;
	}

	h2 {
		margin-bottom: 4px;
	}

	h3 {
		margin: 14px 0 4px;
		color: var(--text-secondary);
	}

	.moved {
		color: var(--serious);
		font-weight: 600;
	}

	/* Review-pass deltas. Colour carries the DIRECTION only — magnitude stays in
	   the number, because a +0.4pp gain and a +40pp gain must not read alike. */
	.good {
		color: var(--good);
		font-weight: 600;
	}

	.bad {
		color: var(--critical);
		font-weight: 600;
	}

	.warn {
		color: var(--warning);
	}

	.churn {
		gap: 24px;
		align-items: flex-start;
		margin-top: 12px;
	}

	.churn > div {
		flex: 1 1 260px;
		min-width: 0;
	}

	.churn h3 {
		font-size: 12px;
		margin: 0 0 4px;
	}

	.churn ul {
		margin: 0;
		padding-left: 18px;
		max-height: 240px;
		overflow-y: auto;
	}

	.diff {
		border-top: 1px solid var(--gridline);
		padding: 8px 0;
		font-size: 12px;
	}

	.diff-item {
		font-weight: 600;
		margin-bottom: 3px;
	}

	.diff-side {
		color: var(--text-secondary);
		margin-bottom: 2px;
	}

	.tag {
		display: inline-block;
		min-width: 42px;
		color: var(--text-muted);
		font-size: 11px;
	}

	.detail-cell {
		max-width: 420px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
