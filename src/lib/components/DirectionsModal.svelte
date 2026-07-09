<script lang="ts">
	import { m } from '$lib/paraglide/messages';

	// A small chooser opened by tapping the venue address: it offers the maps apps
	// a user might prefer (Apple Maps / Google Maps) rather than hard-coding one,
	// each linking to the venue so the user can navigate to it. It owns nothing but
	// its DOM: `open` is bindable so the page can layer its own Escape handling under
	// this one (Escape closes only the topmost layer — see the page's
	// onWindowKeydown). A native <dialog> in the top layer gives the backdrop, focus
	// trap and Escape-to-close for free (mirrors SourcesModal).
	let {
		latitude,
		longitude,
		name,
		address,
		open = $bindable(false)
	}: {
		latitude: number;
		longitude: number;
		name: string;
		address: string;
		open?: boolean;
	} = $props();

	let dialog = $state<HTMLDialogElement | null>(null);

	// The two apps want different inputs to land on the venue nicely:
	//
	// • Apple Maps drops a pin at the EXACT OSM coordinates (`ll`) labelled with the
	//   venue name (`q` acts as a label once `ll` fixes the location) — a named pin
	//   at the precise spot.
	//
	// • Google Maps ignores a name when you hand it bare coordinates: `query=lat,lng`
	//   drops an anonymous "dropped pin" with no place card. Per Google's Maps URLs
	//   guidance ("avoid using only latitude/longitude … when your goal is to display
	//   a specific place's details"; recommended `query=PLACE_NAME, ADDRESS`), we send
	//   a `name, address` text query instead, which resolves to the venue's real place
	//   card (name, hours, Directions). It falls back to the coordinates if a venue
	//   somehow has no address.
	//
	// These are display links handed to a third-party app, not stored data, so the
	// text query is no exception to the OSM-coordinate policy (which governs what WE
	// persist — our own pin stays coordinate-exact).
	const coord = $derived(`${latitude},${longitude}`);
	const appleUrl = $derived(`https://maps.apple.com/?ll=${coord}&q=${encodeURIComponent(name)}`);
	const googleQuery = $derived(address ? `${name}, ${address}` : coord);
	const googleUrl = $derived(
		`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(googleQuery)}`
	);

	// Drive the platform modal from `open`. showModal() puts the dialog in the top
	// layer above the map and detail panel; close() (Escape, backdrop, ✕, or picking
	// a provider) fires the `close` event below, which syncs `open` back to false.
	$effect(() => {
		const el = dialog;
		if (!el) return;
		if (open && !el.open) el.showModal();
		else if (!open && el.open) el.close();
	});

	// A click outside the dialog box (on the backdrop) closes it. The dialog element
	// fills only the box, so a pointer landing beyond its bounds is a backdrop click.
	function onDialogClick(event: MouseEvent) {
		const el = dialog;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const outside =
			event.clientX < rect.left ||
			event.clientX > rect.right ||
			event.clientY < rect.top ||
			event.clientY > rect.bottom;
		if (outside) open = false;
	}
</script>

<dialog
	bind:this={dialog}
	class="directions-modal"
	aria-label={m.directions_dialog_aria()}
	onclose={() => (open = false)}
	onclick={onDialogClick}
>
	<div class="directions-modal__panel">
		<header class="directions-modal__head">
			<h2 class="directions-modal__title">{m.directions_title()}</h2>
			<button
				type="button"
				class="directions-modal__close"
				aria-label={m.directions_close_aria()}
				onclick={() => (open = false)}
			>
				✕
			</button>
		</header>

		<!-- Picking a provider dismisses the chooser as it hands off to the maps app. -->
		<div class="directions-modal__list">
			<a
				class="directions-modal__option"
				href={appleUrl}
				target="_blank"
				rel="external noopener noreferrer"
				onclick={() => (open = false)}
			>
				{m.directions_apple_maps()}
			</a>
			<a
				class="directions-modal__option"
				href={googleUrl}
				target="_blank"
				rel="external noopener noreferrer"
				onclick={() => (open = false)}
			>
				{m.directions_google_maps()}
			</a>
		</div>
	</div>
</dialog>

<style>
	/* The dialog element IS the box (native modal, so it lives in the top layer over
	   the map and detail panel regardless of z-index). Reset the UA centring margins
	   and place it in the viewport centre ourselves. Mirrors SourcesModal. */
	.directions-modal {
		margin: auto;
		width: min(22rem, calc(100vw - 2rem));
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 0.9rem;
		background: rgba(255, 255, 255, 0.96);
		backdrop-filter: blur(16px) saturate(180%);
		-webkit-backdrop-filter: blur(16px) saturate(180%);
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
		color: var(--color-text);
		overflow: hidden;
	}

	.directions-modal::backdrop {
		background: rgba(0, 0, 0, 0.4);
		backdrop-filter: blur(2px);
		-webkit-backdrop-filter: blur(2px);
	}

	.directions-modal__panel {
		display: flex;
		flex-direction: column;
		padding: 0.85rem 0.95rem 1rem;
	}

	.directions-modal__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.6rem;
	}

	.directions-modal__title {
		margin: 0;
		font-size: 1rem;
	}

	.directions-modal__close {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		padding: 0;
		flex-shrink: 0;
		font-size: 0.8rem;
		line-height: 1;
		color: var(--color-text-muted);
		background: rgba(0, 0, 0, 0.04);
		border: 1px solid rgba(0, 0, 0, 0.08);
		border-radius: 999px;
		cursor: pointer;
		transition:
			background-color 0.12s,
			color 0.12s;
	}

	.directions-modal__close:hover {
		color: var(--color-text);
		background: rgba(0, 0, 0, 0.09);
	}

	/* Touch target: keep the 1.6rem ✕, but extend the tappable area to the 44px
	   floor on coarse pointers with a transparent centred overlay. */
	@media (pointer: coarse) {
		.directions-modal__close::after {
			content: '';
			position: absolute;
			top: 50%;
			left: 50%;
			width: 44px;
			height: 44px;
			transform: translate(-50%, -50%);
		}
	}

	.directions-modal__list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	/* Each provider is a full-width tappable button in the accent family (matching
	   the course/sources pills), sized past the 44px touch floor since these are the
	   chooser's primary targets. */
	.directions-modal__option {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		padding: 0.4rem 0.75rem;
		font-size: 0.9rem;
		font-weight: 600;
		text-align: center;
		text-decoration: none;
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 8%, #fff);
		border: 1px solid color-mix(in srgb, var(--color-accent) 30%, #fff);
		border-radius: 0.7rem;
		transition:
			background-color 0.12s,
			border-color 0.12s;
	}

	.directions-modal__option:hover {
		background: color-mix(in srgb, var(--color-accent) 16%, #fff);
		border-color: color-mix(in srgb, var(--color-accent) 45%, #fff);
		text-decoration: none;
	}
</style>
