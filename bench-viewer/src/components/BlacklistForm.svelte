<script lang="ts">
	/**
	 * Record a verdict: retire a (model, effort, backend) configuration.
	 *
	 * This is the one place in the app that writes anything, and it writes a
	 * DECISION, never evidence — `scripts/bench/blacklist.json`, git-tracked, so
	 * the verdict survives a machine change and shows up in a diff. Nothing under
	 * `bench/` is touched.
	 *
	 * `reason` is required, exactly as it is on the CLI. The point of the file is
	 * that a future reader can tell an obsolete verdict from a live one, and a
	 * one-click veto with no why would quietly destroy that — so the button stays
	 * disabled until there is a reason to record.
	 */
	import { untrack } from 'svelte';
	import { addBlacklistEntry } from '../lib/api';
	import { blacklistEffort, refreshData } from '../lib/state.svelte';

	let {
		model,
		lockModel = false,
		efforts = [],
		effort = '*',
		backend = '',
		evidence = '',
		onsaved,
		oncancel
	}: {
		model: string;
		lockModel?: boolean;
		/** Display labels for the level dropdown; `default(…)` is folded to `default`. */
		efforts?: string[];
		effort?: string;
		backend?: string;
		evidence?: string;
		onsaved?: () => void;
		oncancel?: () => void;
	} = $props();

	/**
	 * Seeded ONCE from the props, deliberately: these are a form's initial values,
	 * and every call site mounts this component fresh behind an `{#if}`, so a prop
	 * can only change by remounting. `untrack` says that out loud — without it the
	 * compiler is right to warn that a later prop change would be ignored, and
	 * silently reseeding a half-typed reason on a re-render would be worse.
	 */
	let formModel = $state(untrack(() => model));
	let formEffort = $state(untrack(() => effort));
	let formBackend = $state(untrack(() => backend));
	let formReason = $state('');
	let formEvidence = $state(untrack(() => evidence));
	let saving = $state(false);
	let error = $state<string | null>(null);

	/** `*` first: ruling a model out entirely is the coarsest, most common verdict. */
	let effortOptions = $derived([
		'*',
		...[...new Set(efforts.map((label) => blacklistEffort(label)))].toSorted()
	]);

	let ready = $derived(formModel.trim().length > 0 && formReason.trim().length > 0 && !saving);

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!ready) return;
		saving = true;
		error = null;
		try {
			await addBlacklistEntry({
				model: formModel.trim(),
				effort: formEffort,
				backend: formBackend === '' ? undefined : formBackend,
				reason: formReason.trim(),
				evidence: formEvidence.trim() === '' ? undefined : formEvidence.trim()
			});
			refreshData();
			onsaved?.();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		} finally {
			saving = false;
		}
	}
</script>

<form onsubmit={submit}>
	<div class="fields">
		<label>
			<span>Model</span>
			{#if lockModel}
				<input type="text" value={formModel} readonly />
			{:else}
				<input type="text" bind:value={formModel} placeholder="openai/gpt-5.6-luna" required />
			{/if}
		</label>

		<label>
			<span>Effort scope</span>
			<select bind:value={formEffort}>
				{#each effortOptions as option (option)}
					<option value={option}>
						{option === '*'
							? 'all efforts'
							: option === 'default'
								? 'default (no --effort passed)'
								: option}
					</option>
				{/each}
			</select>
		</label>

		<label>
			<span>Backend</span>
			<select bind:value={formBackend}>
				<option value="">both</option>
				<option value="openrouter">openrouter</option>
				<option value="claude">claude</option>
			</select>
		</label>
	</div>

	<label class="wide">
		<span>Reason <em>(required)</em></span>
		<textarea
			bind:value={formReason}
			rows="3"
			placeholder="Why this configuration is ruled out — the numbers that decided it, and on which tasks."
			required
		></textarea>
	</label>

	<label class="wide">
		<span>Evidence</span>
		<input type="text" bind:value={formEvidence} placeholder="the runs that justified it" />
	</label>

	<p class="muted hint">
		Recorded in the git-tracked blacklist. Runs already in the corpus keep their scores — this only
		stops the configuration being bought again, and hides it from the default view.
	</p>

	{#if error}
		<p class="error">{error}</p>
	{/if}

	<div class="row actions">
		<button type="submit" class="chip primary" disabled={!ready}>
			{saving ? 'Recording…' : 'Record verdict'}
		</button>
		{#if oncancel}
			<button type="button" class="chip" onclick={oncancel}>Cancel</button>
		{/if}
		{#if formReason.trim().length === 0}
			<span class="muted hint">A verdict without its why is unusable — say what ruled it out.</span>
		{/if}
	</div>
</form>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 10px;
	}

	.fields {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
		color: var(--text-secondary);
	}

	label.wide {
		width: 100%;
	}

	em {
		font-style: normal;
		color: var(--text-muted);
	}

	input[type='text'],
	textarea,
	select {
		font: inherit;
		font-size: 13px;
	}

	input[readonly] {
		color: var(--text-secondary);
	}

	textarea {
		resize: vertical;
		font-family: inherit;
	}

	.hint {
		font-size: 11px;
		margin: 0;
	}

	.error {
		color: var(--critical);
		font-size: 12px;
		margin: 0;
	}

	.actions {
		gap: 8px;
		align-items: center;
	}

	.primary[disabled] {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
