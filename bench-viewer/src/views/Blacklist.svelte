<script lang="ts">
	/**
	 * The verdict register: every configuration ruled out, why, and when.
	 *
	 * This is the file `bench:run` consults before spending, rendered. It exists so
	 * a verdict is reviewable rather than folkloric — the reason and the date sit
	 * beside every entry, because "we don't use terra at max" with no why attached
	 * is how a stale decision outlives the model it was made about.
	 *
	 * Removal is as prominent as adding on purpose. Models get updated and old
	 * verdicts expire; a blacklist you cannot undo is a trap, and the CLI keeps
	 * `--remove` for the same reason.
	 */
	import { fetchBlacklist, fetchOverview, removeBlacklistEntry } from '../lib/api';
	import { filters, refreshData, router } from '../lib/state.svelte';
	import BlacklistForm from '../components/BlacklistForm.svelte';
	import Badge from '../components/Badge.svelte';

	let adding = $state(false);
	let removing = $state<string | null>(null);
	let error = $state<string | null>(null);

	// Keyed on the revision so both re-read after any edit made here or anywhere
	// else in the app.
	let data = $derived(await fetchBlacklist(filters.revision));
	let overview = $derived(await fetchOverview(filters.revision));

	/** Runs each verdict currently covers — the size of what it is hiding. */
	let runsByModel = $derived(overview.blacklist.model_states);

	async function remove(entry: {
		model: string;
		effort: string;
		backend: string | null;
	}): Promise<void> {
		removing = entry.model + entry.effort;
		error = null;
		try {
			await removeBlacklistEntry({
				model: entry.model,
				// The wire spells "every level" as `*`; the register displays it as `all`.
				effort: entry.effort === 'all' ? '*' : entry.effort,
				backend: entry.backend ?? undefined
			});
			refreshData();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		} finally {
			removing = null;
		}
	}
</script>

<div class="stack">
	<div class="card">
		<div class="spread">
			<div>
				<h2>Blacklist</h2>
				<p class="muted small">
					Configurations already tested and ruled out. <code>bench:run</code> and
					<code>bench:draft</code> refuse these before spending anything, and this dashboard hides their
					runs unless you ask for them.
				</p>
			</div>
			{#if data.writable}
				<button class="chip primary" aria-pressed={adding} onclick={() => (adding = !adding)}>
					{adding ? 'Close' : '+ Record a verdict'}
				</button>
			{/if}
		</div>

		{#if data.error}
			<p class="error">
				{data.path} could not be read: {data.error}. Nothing is being hidden, and edits are disabled
				— fix the file rather than trusting this page.
			</p>
		{:else if !data.writable}
			<p class="muted small note">
				Read-only (started with <code>--read-only</code>). Edit with
				<code>bun run bench:blacklist</code>.
			</p>
		{/if}

		{#if adding}
			<div class="addbox">
				<BlacklistForm
					model=""
					efforts={overview.facets.efforts}
					onsaved={() => (adding = false)}
					oncancel={() => (adding = false)}
				/>
			</div>
		{/if}

		{#if error}
			<p class="error">{error}</p>
		{/if}

		{#if data.entries.length === 0}
			<p class="muted pad">
				No verdicts recorded — every model and configuration is testable. Entries land here when a
				sweep rules one out.
			</p>
		{:else}
			<div class="scroll-x table-wrap">
				<table>
					<thead>
						<tr>
							<th class="left">Model</th>
							<th class="left">Effort scope</th>
							<th class="left">Backend</th>
							<th class="left">Reason</th>
							<th class="left">Added</th>
							<th class="left">Evidence</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each data.entries as entry (entry.label + entry.added)}
							<tr>
								<td class="left">
									<div class="model">{entry.model}</div>
									{#if runsByModel[entry.model] === undefined}
										<Badge
											tone="neutral"
											label="no runs"
											title="Nothing in the corpus matches this model, so the verdict hides nothing today. It still blocks a future bench:run."
										/>
									{/if}
								</td>
								<td class="left mono">{entry.effort}</td>
								<td class="left">{entry.backend ?? 'both'}</td>
								<td class="left reason">{entry.reason}</td>
								<td class="left mono">{entry.added}</td>
								<td class="left evidence muted small">{entry.evidence ?? '—'}</td>
								<td>
									{#if data.writable}
										<button
											class="chip"
											disabled={removing === entry.model + entry.effort}
											title="Drop this verdict — its runs reappear and bench:run will buy the configuration again."
											onclick={() => remove(entry)}
										>
											{removing === entry.model + entry.effort ? 'Removing…' : 'Remove'}
										</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<p class="muted small note">
				{data.entries.length} verdict{data.entries.length === 1 ? '' : 's'} hiding
				{overview.blacklist.n_blocked_runs} run{overview.blacklist.n_blocked_runs === 1 ? '' : 's'}
				from the default view.
				<button
					class="linky"
					onclick={() => ((filters.includeBlacklisted = true), router.go('leaderboard'))}
				>
					Show them on the leaderboard
				</button>
			</p>
		{/if}
	</div>
</div>

<style>
	.small {
		font-size: 11px;
	}

	.table-wrap {
		margin-top: 12px;
	}

	.model {
		font-weight: 600;
		font-size: 13px;
	}

	.reason {
		white-space: normal;
		min-width: 280px;
		max-width: 520px;
	}

	.evidence {
		white-space: normal;
		max-width: 260px;
	}

	.addbox {
		margin-top: 10px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--series-1) 4%, transparent);
	}

	.error {
		color: var(--critical);
		font-size: 13px;
		margin: 8px 0 0;
	}

	.note {
		margin: 8px 0 0;
	}

	.pad {
		padding: 16px 0 4px;
	}

	code {
		font-family: var(--mono);
		font-size: 12px;
	}

	.linky {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: var(--series-1);
		cursor: pointer;
		text-decoration: underline;
	}
</style>
