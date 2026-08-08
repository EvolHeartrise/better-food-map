<script lang="ts">
	/**
	 * Authoring dashboard — bench:new --status as a live view, plus task
	 * scaffolding. The strata matrix leads because empty strata are what limit
	 * the bench's discrimination; the per-task table carries the work states
	 * (recorded → drafted → authored) with a path into the gold editor.
	 *
	 * Recording a snapshot stays a CLI act (it drives headless Chromium against
	 * the live web); the dashboard shows the exact command instead of a button.
	 */
	import { claimAuthoringTask, createAuthoringTask, fetchAuthoringStatus } from '../lib/api';
	import { router } from '../lib/state.svelte';
	import type { AuthoringStatus } from '../lib/types';

	let refresh = $state(0);
	let status = $derived.by<Promise<AuthoringStatus>>(() => {
		void refresh;
		return fetchAuthoringStatus();
	});

	// --- create / claim forms ---------------------------------------------------

	let newSlug = $state('');
	let newUrl = $state('');
	let newStratum = $state('');
	let claimStratum = $state('');
	let claimSlug = $state('');
	let formOut = $state<{ ok: boolean; text: string } | null>(null);

	async function submitCreate(): Promise<void> {
		const result = await createAuthoringTask({
			slug: newSlug.trim(),
			entry_url: newUrl.trim(),
			stratum: newStratum
		});
		formOut = result.ok
			? { ok: true, text: `created ${result.task_dir} — record a snapshot next` }
			: { ok: false, text: result.error ?? 'create failed' };
		if (result.ok) {
			newSlug = '';
			newUrl = '';
			refresh += 1;
		}
	}

	async function submitClaim(): Promise<void> {
		const result = await claimAuthoringTask({ slug: claimSlug, stratum: claimStratum });
		formOut = result.ok
			? { ok: true, text: `claimed ${result.task_dir}` }
			: { ok: false, text: result.error ?? 'claim failed' };
		if (result.ok) refresh += 1;
	}
</script>

{#await status then data}
	<div class="stack">
		<div class="card">
			<h2>Strata coverage</h2>
			<p class="muted small">
				Empty strata are the bench's blind spots — a model can top every current task and still be
				unmeasured on these page shapes.
			</p>
			<div class="row wrap strata">
				{#each data.by_stratum as entry (entry.stratum)}
					<div class="stratum" class:empty={entry.slugs.length === 0}>
						<span class="name">{entry.stratum}</span>
						<span class="who">{entry.slugs.length === 0 ? 'EMPTY' : entry.slugs.join(', ')}</span>
					</div>
				{/each}
			</div>
		</div>

		<div class="card">
			<h2>Tasks</h2>
			<div class="scroll">
				<table>
					<thead>
						<tr>
							<th>slug</th>
							<th>stratum</th>
							<th>recorded</th>
							<th>gold</th>
							<th>draft pending</th>
							<th class="num">items</th>
							<th>open</th>
						</tr>
					</thead>
					<tbody>
						{#each data.tasks as task (task.slug)}
							<tr>
								<td class="mono">{task.slug}</td>
								<td>{task.stratum}</td>
								<td>{task.recorded ? 'yes' : '—'}</td>
								<td>{task.authored ? 'yes' : '—'}</td>
								<td class={task.draftPending ? 'warn' : ''}>{task.draftPending ? 'yes' : '—'}</td>
								<td class="num">{task.itemCount ?? '—'}</td>
								<td>
									{#if task.draftPending}
										<button
											class="chip"
											onclick={() => router.go('gold', { task: task.slug, file: 'draft' })}
											>review draft</button
										>
									{/if}
									{#if task.authored}
										<button
											class="chip"
											onclick={() => router.go('gold', { task: task.slug, file: 'data' })}
											>edit gold</button
										>
									{/if}
									{#if !task.recorded}
										<code class="small"
											>bun run bench:record bench/tasks/{task.slug} {task.entry_url}</code
										>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<div class="card">
			<h2>New task</h2>
			<p class="muted small">
				Scaffolds the task directory only — recording the snapshot drives a headless browser against
				the live site, so it stays a CLI step and the table above shows the command.
			</p>
			<div class="row wrap forms">
				<div class="form">
					<input placeholder="slug (kebab-case)" bind:value={newSlug} />
					<input placeholder="entry URL" bind:value={newUrl} size="34" />
					<select bind:value={newStratum}>
						<option value="" disabled>stratum…</option>
						{#each data.strata as stratum (stratum)}
							<option value={stratum}>{stratum}</option>
						{/each}
					</select>
					<button class="chip" disabled={!newSlug || !newUrl || !newStratum} onclick={submitCreate}
						>Create</button
					>
				</div>
				<div class="form">
					<select bind:value={claimSlug}>
						<option value="" disabled>existing task…</option>
						{#each data.tasks.filter((t) => t.stratum === '(unset)') as task (task.slug)}
							<option value={task.slug}>{task.slug}</option>
						{/each}
					</select>
					<select bind:value={claimStratum}>
						<option value="" disabled>stratum…</option>
						{#each data.strata as stratum (stratum)}
							<option value={stratum}>{stratum}</option>
						{/each}
					</select>
					<button class="chip" disabled={!claimSlug || !claimStratum} onclick={submitClaim}
						>Claim stratum</button
					>
				</div>
			</div>
			{#if formOut}
				<p class="small {formOut.ok ? 'good' : 'bad'}">{formOut.text}</p>
			{/if}
		</div>
	</div>
{/await}

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.strata {
		gap: 8px;
	}

	.stratum {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 6px 10px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 130px;
	}

	.stratum.empty {
		border-color: var(--critical);
	}

	.stratum.empty .who {
		color: var(--critical);
		font-weight: 600;
	}

	.name {
		font-weight: 600;
		font-size: 12px;
	}

	.who {
		font-size: 11px;
		color: var(--text-secondary);
	}

	.scroll {
		overflow-x: auto;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.mono {
		font-family: var(--mono);
		font-size: 12px;
	}

	.warn {
		color: var(--warning);
		font-weight: 600;
	}

	.forms {
		gap: 24px;
	}

	.form {
		display: flex;
		gap: 6px;
		align-items: center;
		flex-wrap: wrap;
	}

	input,
	select {
		font: inherit;
		font-size: 12px;
		padding: 4px 6px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-1);
		color: var(--text-primary);
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

	code {
		font-family: var(--mono);
		background: color-mix(in srgb, var(--gridline) 50%, transparent);
		padding: 1px 5px;
		border-radius: 4px;
	}
</style>
