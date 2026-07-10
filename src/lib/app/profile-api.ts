// App shim for `$lib/profile.remote` (aliased in the Capacitor build). Same
// export surface the web components import, backed by /api/v1/me/diet.
import { apiGet, apiPut } from './api-client';
import { makeQuery } from './query-resource.svelte';

/** The signed-in user's saved diet (a dietary tag id, or null). Mirrors getDiet. */
export const getDiet = makeQuery(() => apiGet<string | null>('/api/v1/me/diet'));

/**
 * Saves the selected diet, then refreshes getDiet so the map's applied filter
 * updates in step — mirroring the remote setDiet's server-side self-refresh.
 */
export async function setDiet(dietId: string | null): Promise<void> {
	await apiPut('/api/v1/me/diet', { diet: dietId });
	void getDiet()
		.refresh()
		.catch(() => {});
}
