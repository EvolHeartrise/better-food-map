import * as v from 'valibot';
import { query, command } from '$app/server';
import { readDiet, writeDiet } from '$lib/server/diet';

/**
 * The signed-in user's saved diet — a single curated dietary tag id, or `null`
 * when none is set (or signed out). The dietary selector IS this profile: the map
 * pre-applies it as the active filter on load, and {@link setDiet} persists a
 * change. Read/write (incl. the sanitize guard) live in $lib/server/diet, shared
 * with the /api/v1/me/diet endpoint.
 */
export const getDiet = query((): Promise<string | null> => readDiet());

/**
 * Saves the signed-in user's selected diet (a curated dietary tag id, or `null` to
 * clear it), then refreshes {@link getDiet} server-side so the map's applied filter
 * updates in this same response. The id is sanitized to a known dietary tag before
 * storing — an unknown value is stored as `null` (no filter).
 */
export const setDiet = command(v.nullable(v.string()), async (dietId) => {
	await writeDiet(dietId);
	void getDiet().refresh();
});
