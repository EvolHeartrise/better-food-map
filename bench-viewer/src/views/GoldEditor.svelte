<script lang="ts">
	/**
	 * Gold editor route — loads one task's review state plus every crawled
	 * page's text, then hands the lot to the keyed editor component. The split
	 * exists because an editor must OWN its state mutably: a `$derived` model
	 * would clobber in-flight edits on any dependency tick, so the inner
	 * component initialises local `$state` from these props exactly once per
	 * task (the `#key` block remounts it when the task or file changes).
	 */
	import GoldEditorPanel from '../components/GoldEditorPanel.svelte';
	import { fetchAuthoringPage, fetchAuthoringTask } from '../lib/api';
	import { router } from '../lib/state.svelte';

	let slug = $derived(router.param('task') ?? '');
	let fileParam = $derived(router.param('file') === 'draft' ? ('draft' as const) : undefined);

	let payload = $derived(
		await (async () => {
			if (!slug) return null;
			const data = await fetchAuthoringTask(slug, fileParam);
			const texts: Record<string, string> = {};
			// Every page's text up front, so hit status recomputes live while typing.
			await Promise.all(
				data.pages.map(async (page) => {
					texts[page.url] = (await fetchAuthoringPage(slug, page.url)).text;
				})
			);
			return { data, texts };
		})()
	);
</script>

{#if !payload}
	<div class="card">
		<h2>Gold editor</h2>
		<p class="muted">No task selected — open one from the Authoring tab.</p>
		<button class="chip" onclick={() => router.go('authoring')}>Authoring</button>
	</div>
{:else}
	{#key `${payload.data.task}:${payload.data.file}`}
		<GoldEditorPanel data={payload.data} pageTexts={payload.texts} />
	{/key}
{/if}
