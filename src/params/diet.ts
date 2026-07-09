import type { ParamMatcher } from '@sveltejs/kit';
import { dietTagIdFromSlug } from '$lib/browse';

/**
 * The `[diet]` segment of a city browse route: one of the six dietary-tag slugs
 * (`vegan`, `gluten-free`, …). Anything else fails to match, so only real
 * per-diet pages route and the URL space stays finite. The load still 404s a
 * valid diet that has no matching venues in the city (no thin pages).
 */
export const match: ParamMatcher = (value) => dietTagIdFromSlug(value) !== null;
