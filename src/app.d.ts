// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		interface PageState {
			/**
			 * The id of the location whose detail panel is open, set via shallow
			 * routing (`pushState`/`replaceState`). Absent when viewing the results
			 * list. On a fresh load / shared link the id is read from the URL instead
			 * (see the `reroute` hook), since `page.state` is empty on first render.
			 */
			selected?: string;
		}
		// interface Platform {}
	}
}

export {};
