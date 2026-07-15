<script lang="ts">
	import { m } from '$lib/paraglide/messages';

	// The viewer's own review editor: a textarea layered on top of the star rating
	// the panel header already owns. Saving posts the current rating + this text
	// together (the parent supplies the rating); the editor never sets the rating
	// itself. `canSave` is false until a star is chosen — text can't exist without a
	// rating. Deleting removes the whole review (rating + text), per the review model.
	let {
		body = null,
		canSave,
		hasReview,
		hidden = false,
		onSave,
		onDelete
	}: {
		/** The viewer's saved review text, or null. Seeds the draft. */
		body?: string | null;
		/** True once a star rating is chosen (a review needs one). */
		canSave: boolean;
		/** True when a review row already exists (enables Delete). */
		hasReview: boolean;
		/** True when the viewer's own review has been hidden by moderation. */
		hidden?: boolean;
		onSave: (text: string) => Promise<void>;
		onDelete: () => Promise<void>;
	} = $props();

	let open = $state(false);
	let draft = $state('');
	let saving = $state(false);
	let deleting = $state(false);

	function toggle(): void {
		if (!open) draft = body ?? '';
		open = !open;
	}

	async function save(): Promise<void> {
		if (!canSave || saving) return;
		saving = true;
		try {
			await onSave(draft.trim());
			open = false;
		} finally {
			saving = false;
		}
	}

	async function remove(): Promise<void> {
		if (deleting) return;
		deleting = true;
		try {
			await onDelete();
			open = false;
			draft = '';
		} finally {
			deleting = false;
		}
	}
</script>

<div class="editor">
	{#if hidden}
		<p class="editor__hidden">{m.review_hidden_note()}</p>
	{/if}
	{#if !open}
		<button type="button" class="editor__open" onclick={toggle}>
			{hasReview ? m.review_edit() : m.review_add()}
		</button>
	{:else}
		<label class="editor__label" for="review-body">{m.review_your_heading()}</label>
		<textarea
			id="review-body"
			class="editor__text"
			bind:value={draft}
			maxlength={4000}
			rows={4}
			placeholder={m.review_placeholder()}
		></textarea>
		{#if !canSave}
			<p class="editor__hint">{m.review_needs_rating()}</p>
		{/if}
		<div class="editor__actions">
			<button type="button" class="editor__save" disabled={!canSave || saving} onclick={save}>
				{saving ? m.review_saving() : m.review_save()}
			</button>
			<button type="button" class="editor__cancel" onclick={toggle}>{m.review_cancel()}</button>
			{#if hasReview}
				<button type="button" class="editor__delete" disabled={deleting} onclick={remove}>
					{m.review_delete()}
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.editor {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.editor__hidden {
		margin: 0;
		font-size: 0.85rem;
		color: #b91c1c;
	}

	.editor__open {
		align-self: flex-start;
		padding: 0.35rem 0.75rem;
		border: 1px solid rgba(0, 0, 0, 0.2);
		border-radius: 999px;
		background: transparent;
		font: inherit;
		font-size: 0.9rem;
		color: inherit;
		cursor: pointer;
	}

	.editor__open:hover {
		background: rgba(0, 0, 0, 0.05);
	}

	.editor__label {
		font-size: 0.85rem;
		font-weight: 600;
	}

	.editor__text {
		width: 100%;
		resize: vertical;
		padding: 0.5rem;
		border: 1px solid rgba(0, 0, 0, 0.2);
		border-radius: 8px;
		font: inherit;
		font-size: 0.9rem;
	}

	.editor__hint {
		margin: 0;
		font-size: 0.8rem;
		color: #b45309;
	}

	.editor__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.editor__save {
		padding: 0.35rem 0.9rem;
		border: none;
		border-radius: 999px;
		background: #2563eb;
		color: #fff;
		font: inherit;
		font-size: 0.9rem;
		cursor: pointer;
	}

	.editor__save:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.editor__cancel,
	.editor__delete {
		padding: 0.35rem 0.9rem;
		border: 1px solid rgba(0, 0, 0, 0.2);
		border-radius: 999px;
		background: transparent;
		font: inherit;
		font-size: 0.9rem;
		cursor: pointer;
	}

	.editor__delete {
		color: #b91c1c;
		border-color: rgba(185, 28, 28, 0.4);
	}

	.editor__delete:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
