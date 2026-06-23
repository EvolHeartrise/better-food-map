// Structural types shared by the globe components. Kept here (rather than imported
// from $lib/server/db) so the renderer never pulls server-only code into the
// browser bundle — any location-shaped object can be passed in.

import type { Category } from '$lib/category';

/** A geographic bounding box, reported to the parent as the visible area. */
export type Bounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };

/** The visible area plus the slippy zoom it corresponds to. */
export type GlobeView = { bounds: Bounds; zoom: number };

/** Only the fields the globe actually needs to plot and label a location. */
export type GlobeLocation = {
	id: string;
	name: string;
	category: Category | null;
	latitude: number;
	longitude: number;
	address: string | null;
};
