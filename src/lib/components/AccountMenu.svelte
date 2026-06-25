<script lang="ts">
	import LogIn from '@lucide/svelte/icons/log-in';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Clock from '@lucide/svelte/icons/clock';
	import { resolve } from '$app/paths';
	import { signOut } from '$lib/user.remote';
	import type { User, SearchHistoryEntry } from '$lib/server/db';

	// The account control: a "Sign in" pill when signed out, or an avatar that opens
	// a popover (name, recent searches, sign out) when signed in. It owns only its
	// open/closed state and the sign-out call; the parent supplies the user and the
	// recent-search list and decides what re-applying a search does.
	let {
		user,
		recentSearches,
		onApplySearch
	}: {
		user: User | null;
		recentSearches: SearchHistoryEntry[];
		onApplySearch: (entry: SearchHistoryEntry) => void;
	} = $props();

	let open = $state(false);

	const displayName = $derived(user?.name ?? user?.email ?? 'Account');
	const initial = $derived(
		(user?.name ?? user?.email ?? '?').trim().charAt(0).toUpperCase() || '?'
	);

	// Close the popover when a pointer goes down outside the control. The handler is
	// a no-op unless it's open, and `closest('.account')` keeps clicks on the
	// trigger/popover from closing it.
	function handleWindowPointerDown(event: PointerEvent) {
		if (!open) return;
		if (!(event.target as HTMLElement | null)?.closest('.account')) open = false;
	}

	async function handleSignOut() {
		await signOut();
		// Re-run the load so locals.user (and every user-scoped query) resets cleanly.
		location.reload();
	}

	function applyAndClose(entry: SearchHistoryEntry) {
		onApplySearch(entry);
		open = false;
	}

	/** A compact, human description of a logged search for the recent list. */
	function summarize(entry: SearchHistoryEntry): string {
		const parts: string[] = [];
		if (entry.place.trim()) parts.push(`“${entry.place.trim()}”`);
		if (entry.item.trim()) parts.push(entry.item.trim());
		for (const tag of entry.included) parts.push(tag.name);
		for (const tag of entry.excluded) parts.push(`no ${tag.name}`);
		return parts.join(' · ') || 'All places';
	}
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

<div class="account">
	{#if user}
		<button
			type="button"
			class="account__trigger"
			aria-expanded={open}
			aria-haspopup="menu"
			onclick={() => (open = !open)}
		>
			{#if user.picture}
				<img class="account__avatar" src={user.picture} alt="" referrerpolicy="no-referrer" />
			{:else}
				<span class="account__avatar account__avatar--initial" aria-hidden="true">{initial}</span>
			{/if}
			<span class="account__name">{displayName}</span>
		</button>

		{#if open}
			<div class="account__popover" role="menu">
				<div class="account__header">
					<span class="account__header-name">{user.name ?? 'Signed in'}</span>
					{#if user.email}
						<span class="account__header-email">{user.email}</span>
					{/if}
				</div>

				<div class="account__section">
					<p class="account__section-title">
						<Clock size={13} aria-hidden="true" />
						Recent searches
					</p>
					{#if recentSearches.length === 0}
						<p class="account__empty">Your searches will show up here.</p>
					{:else}
						<ul class="account__searches">
							{#each recentSearches as entry (entry.id)}
								<li>
									<button
										type="button"
										class="account__search"
										onclick={() => applyAndClose(entry)}
									>
										{summarize(entry)}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				<button type="button" class="account__signout" onclick={handleSignOut}>
					<LogOut size={15} aria-hidden="true" />
					Sign out
				</button>
			</div>
		{/if}
	{:else}
		<a class="account__signin" href={resolve('/auth/login/google')}>
			<LogIn size={16} aria-hidden="true" />
			Sign in
		</a>
	{/if}
</div>

<style>
	.account {
		position: relative;
	}

	/* Shared glass pill, matching the search controls' look. */
	.account__trigger,
	.account__signin {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.4rem 0.7rem;
		border: 1px solid rgba(255, 255, 255, 0.6);
		border-radius: 0.7rem;
		background: rgba(255, 255, 255, 0.72);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.16);
		color: inherit;
		font: inherit;
		font-size: 0.85rem;
		text-decoration: none;
		cursor: pointer;
		max-width: 12rem;
	}

	.account__name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.account__avatar {
		width: 1.4rem;
		height: 1.4rem;
		border-radius: 999px;
		object-fit: cover;
		flex-shrink: 0;
	}

	.account__avatar--initial {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: #e0245e;
		color: #fff;
		font-size: 0.75rem;
		font-weight: 600;
	}

	.account__popover {
		position: absolute;
		z-index: 20;
		top: calc(100% + 0.4rem);
		left: 0;
		width: min(18rem, calc(100vw - 2rem));
		display: flex;
		flex-direction: column;
		padding: 0.5rem;
		border-radius: 0.9rem;
		background: rgba(255, 255, 255, 0.92);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		border: 1px solid rgba(255, 255, 255, 0.6);
		box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22);
	}

	.account__header {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.4rem 0.5rem 0.5rem;
		border-bottom: 1px solid rgba(0, 0, 0, 0.08);
	}

	.account__header-name {
		font-weight: 600;
		font-size: 0.9rem;
	}

	.account__header-email {
		font-size: 0.78rem;
		color: rgba(0, 0, 0, 0.55);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.account__section {
		padding: 0.5rem 0.25rem;
	}

	.account__section-title {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin: 0 0 0.35rem;
		padding: 0 0.25rem;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: rgba(0, 0, 0, 0.5);
	}

	.account__empty {
		margin: 0;
		padding: 0 0.25rem;
		font-size: 0.82rem;
		color: rgba(0, 0, 0, 0.5);
	}

	.account__searches {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		max-height: 14rem;
		overflow-y: auto;
	}

	.account__search {
		display: block;
		width: 100%;
		padding: 0.4rem 0.45rem;
		border: none;
		border-radius: 0.5rem;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 0.84rem;
		text-align: left;
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.account__search:hover {
		background: rgba(0, 0, 0, 0.06);
	}

	.account__signout {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin-top: 0.25rem;
		padding: 0.5rem;
		border: none;
		border-top: 1px solid rgba(0, 0, 0, 0.08);
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 0.85rem;
		text-align: left;
		cursor: pointer;
		border-radius: 0 0 0.5rem 0.5rem;
	}

	.account__signout:hover {
		background: rgba(0, 0, 0, 0.06);
	}
</style>
