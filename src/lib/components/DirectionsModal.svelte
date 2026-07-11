<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import Modal from './Modal.svelte';

	// A small chooser opened by tapping the venue address: it offers the maps apps
	// a user might prefer (Apple Maps / Google Maps) rather than hard-coding one,
	// each linking to the venue so the user can navigate to it. The shared Modal owns
	// the dialog shell (backdrop, focus trap, Escape-to-close, header/✕); this
	// component supplies the provider list. `open` is bindable so the page can layer
	// its own Escape handling under this one.
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
</script>

<Modal
	bind:open
	title={m.directions_title()}
	ariaLabel={m.directions_dialog_aria()}
	closeLabel={m.directions_close_aria()}
	width="min(22rem, calc(100vw - 2rem))"
>
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
</Modal>

<style>
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
