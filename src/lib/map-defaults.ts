// Shared map view defaults. Pure and client-safe (no server-only imports), so
// components that must stay out of the server bundle — <LocationMap> in
// particular — can import it freely.

// The fallback opening view when nothing better is known (no saved viewport,
// no IP geolocation): central Vancouver, the densest coverage in the
// Canada-first dataset. Stored `[lat, lng]` to match <LocationMap>'s prop
// contract (MapLibre itself wants `[lng, lat]`). Typed as a plain tuple —
// not `readonly` — so it can flow into call sites taking a mutable
// `[number, number]` (e.g. `toLngLat`); treat it as immutable regardless.
export const DEFAULT_MAP_CENTER: [number, number] = [49.2827, -123.1207];
