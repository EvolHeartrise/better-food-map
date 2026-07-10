// The edge-IP opening location, factored out of data.remote.ts so the
// `getUserLocation` remote function AND the GET /api/v1/user-location endpoint
// share ONE implementation of the `platform.cf` read and its guards.
import { getRequestEvent } from '$app/server';

/**
 * Best-effort opening location for the map, from Cloudflare's edge IP
 * geolocation (`request.cf`). Prompt-free — unlike the browser Geolocation API it
 * needs no permission — at the cost of being only city-level accurate (and skewed
 * by VPNs / mobile carriers). Only the Worker can see `request.cf`, which is why
 * this is server-side. Returns `null` when coordinates are unavailable (notably
 * under local `vite dev`, where the edge metadata is absent); the map falls back
 * to its built-in default view.
 */
export function resolveUserLocation(): { lat: number; lng: number } | null {
	const { platform } = getRequestEvent();
	const cf = platform?.cf;
	// `latitude`/`longitude` arrive as strings; empty/absent values are falsy and
	// short-circuit here, so `Number('')` (which is 0, i.e. the Gulf of Guinea)
	// can never slip through as a real coordinate.
	if (!cf?.latitude || !cf?.longitude) return null;
	const lat = Number(cf.latitude);
	const lng = Number(cf.longitude);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	return { lat, lng };
}
