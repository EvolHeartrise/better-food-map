<script lang="ts">
	import LogIn from '@lucide/svelte/icons/log-in';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Languages from '@lucide/svelte/icons/languages';
	import Check from '@lucide/svelte/icons/check';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { signOut } from '$lib/user.remote';
	import { setLocale } from '$lib/locale.remote';
	import { safeInternalPath } from '$lib/redirect';
	import { m } from '$lib/paraglide/messages';
	import { getLocale, locales, type Locale } from '$lib/paraglide/runtime';
	import type { User } from '$lib/server/db';

	// The account control: a popover that holds the per-user preferences (there is no
	// settings page). Signed in, the trigger is the avatar and the popover carries the
	// name, the LANGUAGE PICKER and sign-out; signed out, the trigger shows the current
	// language and the popover carries the picker plus a sign-in link — so an anonymous
	// visitor can still pick a language. It owns its open/closed state and the mutations;
	// the parent supplies the user. `open` is bindable so the page can layer its own
	// window-level Escape handling under the popover's (Escape closes only the topmost
	// layer) without probing this component's DOM.
	let {
		user,
		open = $bindable(false)
	}: {
		user: User | null;
		open?: boolean;
	} = $props();

	let rootEl: HTMLDivElement;
	// One ref for whichever trigger is rendered (avatar when signed in, language pill
	// when signed out); only one exists at a time, so a single binding serves both.
	let triggerEl: HTMLButtonElement | undefined = $state();

	const displayName = $derived(user?.name ?? user?.email ?? m.account_default_name());
	const initial = $derived(
		(user?.name ?? user?.email ?? '?').trim().charAt(0).toUpperCase() || '?'
	);

	// The locale this render was produced in. The server resolves it (cookie → saved →
	// Accept-Language → 'en') and stamps <html lang>, which Paraglide's client getLocale()
	// reads back — so this agrees with the SSR'd copy with no extra client state. It marks
	// the checked option; picking another reloads the page, which re-resolves it.
	const currentLocale = getLocale();

	// Each language labelled in its OWN language (an endonym): a proper noun that reads
	// the same whatever the UI locale, so it is not a translated message. Adding a locale
	// to Paraglide's `locales` means adding its endonym here.
	const localeLabels: Record<Locale, string> = {
		'en-US': 'English (US)',
		'en-CA': 'English (Canada)',
		'en-GB': 'English (UK)',
		fr: 'Français (Canada)',
		'fr-FR': 'Français (France)',
		zh: '中文（简体）',
		yue: '粵語',
		pa: 'ਪੰਜਾਬੀ',
		fil: 'Filipino',
		hi: 'हिन्दी',
		es: 'Español',
		it: 'Italiano',
		de: 'Deutsch',
		ur: 'اردو',
		pt: 'Português',
		ru: 'Русский',
		vi: 'Tiếng Việt',
		fa: 'فارسی',
		ta: 'தமிழ்',
		ko: '한국어',
		pl: 'Polski',
		ar: 'العربية'
	};

	// The signed-out fallback (the app is normally reached only when signed in, but a
	// session can expire while the map is open) sends the user through Google sign-in
	// and back to wherever they were, rather than the default landing target. Validated
	// to a same-origin path, mirroring the landing page's own sign-in link.
	const loginHref = $derived(
		`${resolve('/auth/login/google')}?redirectTo=${encodeURIComponent(
			safeInternalPath(page.url.pathname + page.url.search)
		)}`
	);

	// Guards against a double-pick while the reload is in flight.
	let switching = $state(false);

	async function chooseLanguage(locale: Locale): Promise<void> {
		if (switching || locale === currentLocale) {
			open = false;
			return;
		}
		switching = true;
		try {
			// Sets the consent-exempt preference cookie and, if signed in, saves to D1.
			await setLocale(locale);
			// Full reload ONLY on success, so the SSR-rendered strings AND <html lang>
			// re-render together in the new locale — a client-only swap would desync them.
			location.reload();
		} catch {
			// Persist failed (offline / server error): nothing changed, so don't reload
			// (that would throw away the map viewport for no result). Re-enable the
			// buttons and leave the popover open so the user can retry.
			switching = false;
		}
	}

	// Escape closes the popover from anywhere (the trigger or a control inside may hold
	// focus); a pointerdown outside the control closes it too. Both are handled on the
	// window — mirroring DietSelector — and `closest('.account')` keeps clicks on the
	// trigger/popover from closing it. When focus is inside the control it returns to the
	// trigger, so closing the popover can't drop it to <body>; an outside click keeps
	// focus where the user put it.
	function handleWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && open) {
			event.preventDefault();
			open = false;
			if (rootEl.contains(document.activeElement)) triggerEl?.focus();
		}
	}

	function handleWindowPointerDown(event: PointerEvent) {
		if (!open) return;
		if (!(event.target as HTMLElement | null)?.closest('.account')) open = false;
	}

	async function handleSignOut() {
		// Reload even if signOut rejects: the page re-renders whatever the true session
		// state is, so a failed sign-out visibly leaves the user signed in (the feedback).
		try {
			await signOut();
		} finally {
			// Re-run the load so locals.user (and every user-scoped query) resets cleanly.
			location.reload();
		}
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} onpointerdown={handleWindowPointerDown} />

<!-- The language picker, shared by the signed-in and signed-out popovers: a labelled
     group of toggle buttons, the active locale pressed (and check-marked). -->
{#snippet languagePicker()}
	<div class="account__section">
		<span class="account__section-title" id="account-language-label">{m.language_label()}</span>
		<div class="account__langs" role="group" aria-labelledby="account-language-label">
			{#each locales as locale (locale)}
				<button
					type="button"
					class="account__lang"
					class:account__lang--selected={locale === currentLocale}
					aria-pressed={locale === currentLocale}
					disabled={switching}
					onclick={() => chooseLanguage(locale)}
				>
					<span class="account__lang-check" aria-hidden="true">
						{#if locale === currentLocale}
							<Check size={14} />
						{/if}
					</span>
					{localeLabels[locale]}
				</button>
			{/each}
		</div>
	</div>
{/snippet}

<div class="account" bind:this={rootEl}>
	{#if user}
		<button
			type="button"
			class="account__trigger"
			aria-expanded={open}
			bind:this={triggerEl}
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
			<!-- A plain disclosure popover (name + language + sign-out), not a menu: the
			     trigger's aria-expanded already conveys the open state, and role="menu" would
			     require menuitem children these aren't. -->
			<div class="account__popover">
				<div class="account__header">
					<span class="account__header-name">{user.name ?? m.account_signed_in()}</span>
					{#if user.email}
						<span class="account__header-email">{user.email}</span>
					{/if}
				</div>

				{@render languagePicker()}

				<button type="button" class="account__signout" onclick={handleSignOut}>
					<LogOut size={15} aria-hidden="true" />
					{m.account_sign_out()}
				</button>
			</div>
		{/if}
	{:else}
		<button
			type="button"
			class="account__trigger"
			aria-label={`${m.language_label()}: ${localeLabels[currentLocale]}`}
			aria-expanded={open}
			bind:this={triggerEl}
			onclick={() => (open = !open)}
		>
			<Languages size={16} aria-hidden="true" />
			<span class="account__name">{localeLabels[currentLocale]}</span>
		</button>

		{#if open}
			<div class="account__popover">
				{@render languagePicker()}

				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved login path with the redirectTo query the login route reads -->
				<a class="account__signin" href={loginHref}>
					<LogIn size={16} aria-hidden="true" />
					{m.account_sign_in()}
				</a>
			</div>
		{/if}
	{/if}
</div>

<style>
	.account {
		position: relative;
	}

	/* Shared glass pill, matching the search controls' look. The fixed height (shared
	   via --control-height) keeps it level with the search and diet bubbles. */
	.account__trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		height: var(--control-height);
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

	/* The language section: a small labelled group of locale toggles. A divider on top
	   separates it from whatever sits above (the header, or nothing when signed out). */
	.account__section {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.5rem 0.5rem 0.4rem;
		margin-top: 0.25rem;
		border-top: 1px solid rgba(0, 0, 0, 0.08);
	}

	.account__section-title {
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		/* 50% black (≈3.9:1) fails WCAG 1.4.3 for this ~11.5px uppercase label; the muted
		   token (#5c5c66, ≈6.3:1) matches the pill count fix and clears 4.5:1. */
		color: var(--color-text-muted);
	}

	/* With 23 locales a single column would tower past the viewport, so the picker
	   lays the endonyms out in two columns and scrolls once it outgrows the cap
	   (short phones); the check gutter keeps the two-column labels aligned. */
	.account__langs {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.1rem;
		max-height: min(19rem, 50vh);
		overflow-y: auto;
	}

	.account__lang {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.4rem 0.5rem;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 0.85rem;
		text-align: left;
		border-radius: 0.5rem;
		cursor: pointer;
	}

	.account__lang:hover,
	.account__lang:focus-visible {
		outline: none;
		background: rgba(0, 0, 0, 0.06);
	}

	.account__lang:disabled {
		cursor: default;
	}

	.account__lang--selected {
		font-weight: 600;
	}

	/* Fixed-width gutter so the labels line up whether or not an option is check-marked. */
	.account__lang-check {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 0.95rem;
		flex-shrink: 0;
		color: var(--color-accent);
	}

	.account__signout,
	.account__signin {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.5rem;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 0.85rem;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		/* Sits directly under the section above, so it carries the divider that
		   separates it. */
		margin-top: 0.25rem;
		border-top: 1px solid rgba(0, 0, 0, 0.08);
		border-radius: 0 0 0.5rem 0.5rem;
	}

	.account__signout:hover,
	.account__signin:hover {
		background: rgba(0, 0, 0, 0.06);
	}
</style>
