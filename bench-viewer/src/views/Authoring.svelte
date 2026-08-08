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
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import * as Table from '$lib/components/ui/table';

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
	<div class="flex flex-col gap-4">
		<Card.Root size="sm">
			<Card.Header class="gap-0">
				<Card.Title>Strata coverage</Card.Title>
				<Card.Description class="text-xs">
					Empty strata are the bench's blind spots — a model can top every current task and still be
					unmeasured on these page shapes.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="flex flex-wrap gap-2">
					{#each data.by_stratum as entry (entry.stratum)}
						<div
							class="flex min-w-[130px] flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 {entry
								.slugs.length === 0
								? 'border-critical/60'
								: ''}"
						>
							<span class="text-xs font-semibold">{entry.stratum}</span>
							<span
								class="text-[11px] {entry.slugs.length === 0
									? 'font-semibold text-critical'
									: 'text-muted-foreground'}"
								>{entry.slugs.length === 0 ? 'EMPTY' : entry.slugs.join(', ')}</span
							>
						</div>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Header class="gap-0">
				<Card.Title>Tasks</Card.Title>
			</Card.Header>
			<Card.Content>
				<Table.Root class="text-[13px]">
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head class="text-xs">slug</Table.Head>
							<Table.Head class="text-xs">stratum</Table.Head>
							<Table.Head class="text-xs">recorded</Table.Head>
							<Table.Head class="text-xs">gold</Table.Head>
							<Table.Head class="text-xs">draft pending</Table.Head>
							<Table.Head class="text-right text-xs">items</Table.Head>
							<Table.Head class="text-xs">open</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.tasks as task (task.slug)}
							<Table.Row class="hover:bg-primary/5">
								<Table.Cell class="font-mono text-xs">{task.slug}</Table.Cell>
								<Table.Cell>{task.stratum}</Table.Cell>
								<Table.Cell>{task.recorded ? 'yes' : '—'}</Table.Cell>
								<Table.Cell>{task.authored ? 'yes' : '—'}</Table.Cell>
								<Table.Cell class={task.draftPending ? 'font-semibold text-serious' : ''}
									>{task.draftPending ? 'yes' : '—'}</Table.Cell
								>
								<Table.Cell class="text-right tabular-nums">{task.itemCount ?? '—'}</Table.Cell>
								<Table.Cell class="py-1">
									<div class="flex flex-wrap items-center gap-1.5">
										{#if task.draftPending}
											<Button
												variant="outline"
												size="xs"
												class="h-6 rounded-full font-normal"
												onclick={() => router.go('gold', { task: task.slug, file: 'draft' })}
												>review draft</Button
											>
										{/if}
										{#if task.authored}
											<Button
												variant="outline"
												size="xs"
												class="h-6 rounded-full font-normal"
												onclick={() => router.go('gold', { task: task.slug, file: 'data' })}
												>edit gold</Button
											>
										{/if}
										{#if !task.recorded}
											<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
												>bun run bench:record bench/tasks/{task.slug} {task.entry_url}</code
											>
										{/if}
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Header class="gap-0">
				<Card.Title>New task</Card.Title>
				<Card.Description class="text-xs">
					Scaffolds the task directory only — recording the snapshot drives a headless browser
					against the live site, so it stays a CLI step and the table above shows the command.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="flex flex-wrap items-center gap-x-6 gap-y-3">
					<div class="flex flex-wrap items-center gap-1.5">
						<Input placeholder="slug (kebab-case)" bind:value={newSlug} class="h-8 w-44 text-xs" />
						<Input placeholder="entry URL" bind:value={newUrl} class="h-8 w-72 text-xs" />
						<Select.Root type="single" bind:value={newStratum}>
							<Select.Trigger size="sm" class="h-8 text-xs">
								{newStratum || 'stratum…'}
							</Select.Trigger>
							<Select.Content>
								{#each data.strata as stratum (stratum)}
									<Select.Item value={stratum} label={stratum} />
								{/each}
							</Select.Content>
						</Select.Root>
						<Button size="sm" disabled={!newSlug || !newUrl || !newStratum} onclick={submitCreate}
							>Create</Button
						>
					</div>
					<div class="flex flex-wrap items-center gap-1.5">
						<Select.Root type="single" bind:value={claimSlug}>
							<Select.Trigger size="sm" class="h-8 text-xs">
								{claimSlug || 'existing task…'}
							</Select.Trigger>
							<Select.Content>
								{#each data.tasks.filter((t) => t.stratum === '(unset)') as task (task.slug)}
									<Select.Item value={task.slug} label={task.slug} />
								{/each}
							</Select.Content>
						</Select.Root>
						<Select.Root type="single" bind:value={claimStratum}>
							<Select.Trigger size="sm" class="h-8 text-xs">
								{claimStratum || 'stratum…'}
							</Select.Trigger>
							<Select.Content>
								{#each data.strata as stratum (stratum)}
									<Select.Item value={stratum} label={stratum} />
								{/each}
							</Select.Content>
						</Select.Root>
						<Button
							size="sm"
							variant="outline"
							disabled={!claimSlug || !claimStratum}
							onclick={submitClaim}>Claim stratum</Button
						>
					</div>
				</div>
				{#if formOut}
					<p class="mt-2 text-[11px] {formOut.ok ? 'text-good' : 'text-critical'}">
						{formOut.text}
					</p>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
{/await}
