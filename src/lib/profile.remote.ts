import * as v from 'valibot';
import { query, command } from '$app/server';
import { requireDb, currentUser, requireUser } from '$lib/server/context';
import {
	getDietProfile as getDietProfileFromDb,
	setDietProfile as setDietProfileToDb,
	resolveDietProfileFilters,
	type DietProfileFilters
} from '$lib/server/db';
import {
	EMPTY_DIET_PROFILE,
	sanitizeProfile,
	profileIncludeTagIds,
	profileExcludeIngredientNames,
	type DietProfile
} from '$lib/diet-profile';

/**
 * The signed-in user's saved dietary profile (restriction/allergen KEYS), or an
 * empty profile when signed out. Backs the profile editor so it can show the
 * current selections; the page reads {@link getProfileFilters} instead to pre-apply.
 */
export const getDietProfile = query(async (): Promise<DietProfile> => {
	const user = currentUser();
	if (!user) return EMPTY_DIET_PROFILE;
	return getDietProfileFromDb(requireDb(), user.id);
});

const EMPTY_FILTERS: DietProfileFilters = { included: [], excluded: [] };

/**
 * The signed-in user's profile RESOLVED to concrete include/exclude tags, ready to
 * seed the map's two tag pickers as default filters (empty when signed out / no
 * profile). Kept separate from {@link getDietProfile} so the page can pre-apply the
 * filters without re-implementing the key→tag mapping, and so a saved profile change
 * refreshes both the editor's view and the applied filters in one round trip.
 */
export const getProfileFilters = query(async (): Promise<DietProfileFilters> => {
	const user = currentUser();
	if (!user) return EMPTY_FILTERS;
	const profile = await getDietProfileFromDb(requireDb(), user.id);
	return resolveDietProfileFilters(
		requireDb(),
		profileIncludeTagIds(profile),
		profileExcludeIngredientNames(profile)
	);
});

const ProfileSchema = v.object({
	restrictions: v.array(v.string()),
	allergies: v.array(v.string())
});

/**
 * Saves the signed-in user's dietary profile, then refreshes both profile queries
 * server-side (single-flight) so the editor and the map's applied filters update in
 * this same response. Unknown keys are dropped before storing (only catalog keys are
 * ever persisted).
 */
export const setDietProfile = command(ProfileSchema, async (input) => {
	const user = requireUser();
	await setDietProfileToDb(requireDb(), user.id, sanitizeProfile(input), Date.now());
	void getDietProfile().refresh();
	void getProfileFilters().refresh();
});
