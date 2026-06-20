import * as v from 'valibot';
import { query } from '$app/server';
import {
	getLocationsWithMenus,
	getLocationById,
	getFoodByLocation,
	getAllTags,
	type Tag,
	type LocationWithMenu
} from '$lib/server/db';

/**
 * Returns every location merged with its full `menu` (each menu item carries its
 * own dietary tags). Used by the map page to render markers and to show, under
 * each result, the menu items matching the active search/filter query.
 */
export const getLocations = query(async (): Promise<LocationWithMenu[]> => {
	return getLocationsWithMenus();
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
