import * as v from 'valibot';
import { query, command } from '$app/server';
import { requireDb, currentUser, requireUser } from '$lib/server/context';
import { getUserDiet, setUserDiet } from '$lib/server/db';
import { sanitizeDiet } from '$lib/diet-profile';

/**
 * The signed-in user's saved diet — a single curated dietary tag id, or `null`
 * when none is set (or signed out). The dietary selector IS this profile: the map
 * pre-applies it as the active filter on load, and {@link setDiet} persists a
 * change. Sanitized on read so a stored id no longer in the catalog reads as "no
 * filter" rather than a broken selection.
 */
export const getDiet = query(async (): Promise<string | null> => {
	const user = currentUser();
	if (!user) return null;
	return sanitizeDiet(await getUserDiet(requireDb(), user.id));
});

/**
 * Saves the signed-in user's selected diet (a curated dietary tag id, or `null` to
 * clear it), then refreshes {@link getDiet} server-side so the map's applied filter
 * updates in this same response. The id is sanitized to a known dietary tag before
 * storing — an unknown value is stored as `null` (no filter).
 */
export const setDiet = command(v.nullable(v.string()), async (dietId) => {
	const user = requireUser();
	await setUserDiet(requireDb(), user.id, sanitizeDiet(dietId), Date.now());
	void getDiet().refresh();
});
