import * as v from 'valibot';
import { query } from '$app/server';
import {
	getAllLocations,
	getLocationById,
	getFoodByLocation,
	type Location,
	type LocationWithMenu
} from '$lib/server/db';

/**
 * Returns every location (without its menu). Used by the map page.
 */
export const getLocations = query(async (): Promise<Location[]> => {
	return getAllLocations();
});

/**
 * Returns a single location merged with its `menu` array, or `null` if the
 * location does not exist. Used by the location-detail page.
 */
export const getLocation = query(v.string(), async (id): Promise<LocationWithMenu | null> => {
	const location = getLocationById(id);
	if (!location) return null;

	const menu = getFoodByLocation(id);
	return { ...location, menu };
});
