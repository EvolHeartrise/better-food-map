import * as v from 'valibot';
import { query } from '$app/server';
import {
	getLocationsWithTags,
	getLocationById,
	getFoodByLocation,
	getAllTags,
	type Tag,
	type LocationWithTags,
	type LocationWithMenu
} from '$lib/server/db';

/**
 * Returns every location (without its full menu) along with the distinct set of
 * dietary tags offered across its menu. Used by the map page and its filters.
 */
export const getLocations = query(async (): Promise<LocationWithTags[]> => {
	return getLocationsWithTags();
});

/**
 * Returns the canonical, app-defined dietary tag list. Used to render the
 * filter controls. Tags are not user-authored.
 */
export const getTags = query(async (): Promise<Tag[]> => {
	return getAllTags();
});

/**
 * Returns a single location merged with its `menu` array (each menu item
 * carries its own dietary tags), or `null` if the location does not exist.
 * Used by the location-detail page.
 */
export const getLocation = query(v.string(), async (id): Promise<LocationWithMenu | null> => {
	const location = getLocationById(id);
	if (!location) return null;

	const menu = getFoodByLocation(id);
	return { ...location, menu };
});
