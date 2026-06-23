// Tunables for the 3D globe renderer, gathered in one place. Distances are in
// globe-radius units (see GLOBE_RADIUS); a value of 1 sits on the surface.

import { GLOBE_RADIUS } from './geo';

// --- Camera & controls ----------------------------------------------------
export const CAMERA_FOV = 45;
// How close/far the camera may orbit. The minimum hovers just above the surface
// (street-ish), the maximum frames the whole globe with space around it.
export const MIN_CAMERA_DISTANCE = GLOBE_RADIUS * 1.04;
export const MAX_CAMERA_DISTANCE = GLOBE_RADIUS * 4.5;
// Opening distance when no place is selected — a regional, tilted-down view.
export const DEFAULT_CAMERA_DISTANCE = GLOBE_RADIUS * 2.6;
// Distance the camera flies to when a location is selected (a close-in look).
export const SELECTED_CAMERA_DISTANCE = GLOBE_RADIUS * 1.18;
// Near/far planes sized around the unit sphere with room for the cap and tiles.
export const CAMERA_NEAR = 0.01;
export const CAMERA_FAR = 100;

// Fallback opening centre [lat, lng] when no IP-detected centre is supplied —
// a sensible starting view, not tied to any particular city. Matches the value
// the old MapLibre renderer fell back to.
export const DEFAULT_CENTER: [number, number] = [49.2827, -123.1207];

// Exponential-smoothing rate for the fly-to animation (higher = snappier). The
// camera covers ~1 - e^(-rate·seconds) of the remaining arc each second.
export const FLY_RATE = 6;

// --- Tiles ----------------------------------------------------------------
// A low fixed zoom whose tiles always blanket the whole globe, so there's full
// imagery even when zoomed out; higher-detail tiles refine the viewed area on top.
export const BASE_TILE_ZOOM = 2;
// Roughly how many detail tiles should span the view horizontally; drives the
// chosen detail zoom (see selectZoom).
export const TILES_ACROSS = 2.5;
export const MIN_DETAIL_ZOOM = BASE_TILE_ZOOM;
// OSM raster tiles stop at z19; never request past real tile data.
export const MAX_DETAIL_ZOOM = 19;
// Hard cap on simultaneously-loaded detail tiles, a backstop on memory/requests.
export const MAX_DETAIL_TILES = 48;
// Mesh subdivision per tile patch. Low-zoom tiles span more curvature so they get
// more segments; high-zoom tiles are nearly flat and need fewer. Generous counts
// keep the draped imagery smoothly hugging the sphere rather than faceting — the
// vertex totals stay small (a 32-seg tile is ~1k verts, ~16 base tiles).
export function tileSegments(z: number): number {
	if (z <= 2) return 32;
	if (z <= 4) return 16;
	if (z <= 7) return 8;
	return 4;
}
// Altitude (fraction of radius) each layer sits above the base sphere, so layers
// don't z-fight. Detail sits just above base imagery.
export const BASE_TILE_ALTITUDE = 0.001;
export const DETAIL_TILE_ALTITUDE = 0.002;

// OpenStreetMap raster tiles, round-robined across subdomains. OSM's tile policy
// and the ODbL require the attribution shown below (surfaced in the DOM overlay).
export const OSM_TILE_SUBDOMAINS = ['a', 'b', 'c'];
export function osmTileUrl(z: number, x: number, y: number): string {
	const sub = OSM_TILE_SUBDOMAINS[(x + y) % OSM_TILE_SUBDOMAINS.length];
	return `https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
}
export const OSM_ATTRIBUTION_HTML =
	'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

// Colour of the base sphere shown beneath the imagery (and at the poles, which
// Mercator tiles never reach) — a muted ocean tone.
export const OCEAN_COLOR = '#a9c7d8';

// Width/height segments of the base sphere. High enough that its silhouette (the
// globe's limb when zoomed out) and the poles read as a smooth curve, not a
// faceted polygon — it's a single mesh, so the cost is negligible.
export const BASE_SPHERE_SEGMENTS: [number, number] = [160, 120];

// The scene background behind the globe — a deep "space" tone. Set as the scene's
// background so it's painted regardless of the canvas's alpha.
export const SPACE_COLOR = '#070b14';

// --- Markers --------------------------------------------------------------
// Marker fill, matching the app's accent (--color-accent), and the selected
// highlight (accent-hover), so pins read as part of the brand.
export const MARKER_COLOR = '#2f6f4f';
export const MARKER_SELECTED_COLOR = '#f08c3c';
// Marker radius as a fraction of the globe radius, and how its on-screen size is
// kept roughly steady by scaling with camera distance (clamped both ways).
export const MARKER_BASE_RADIUS = GLOBE_RADIUS * 0.008;
export const MARKER_MIN_SCALE = 0.5;
export const MARKER_MAX_SCALE = 2.4;
// The selected marker is drawn this much larger than the rest.
export const MARKER_SELECTED_SCALE = 1.7;
// Markers float a hair above the surface so they're never buried in the imagery.
export const MARKER_ALTITUDE = 0.004;
// Pre-allocated instance buffer. Comfortably above the server's 200-location
// viewport cap (plus the one selected location that may sit outside it).
export const MARKER_INSTANCE_LIMIT = 256;

// Debounce before reporting a settled viewport, so a drag/zoom resolves into a
// single data fetch rather than firing on every intermediate frame.
export const VIEW_DEBOUNCE_MS = 250;
// Grow the reported box by this fraction of each span (markers just off-screen
// preload; small moves don't refetch).
export const BOUNDS_PADDING = 0.2;
