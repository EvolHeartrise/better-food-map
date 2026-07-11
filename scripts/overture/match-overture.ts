// ---------------------------------------------------------------------------
// Matches OSM staging POIs to Overture Maps "places" so gaps can be filled
// from Overture's (permissively-licensed) feed: matchNearestPlaces is the
// generic core (used by the contacts/identity pass in enrich-contacts.ts);
// matchOverturePlaces is the address pass's wrapper over it.
//
// OSM stays the canonical/coordinate source — we take ONLY the address from
// Overture and never its coordinates (which come from conflated commercial
// sources and would break the coordinate-exact dedup invariant in CLAUDE.md).
// A match is the NEAREST Overture place within `radiusM` whose name is related
// to the POI's (proximity-anchored, so short brand names like "KFC" are allowed
// to match "Taco Bell / KFC"). Pure/deterministic — tested in match-overture.test.ts.
//
// The fetch of the Overture feed itself is a separate, documented step (DuckDB
// over the public GeoParquet release); this module only does the matching.
// ---------------------------------------------------------------------------

import { composeAddressLine } from '../../src/lib/address';
import { bboxAround, haversineMeters, SpatialGrid } from '../osm/geo';
import { normalizeName } from '../osm/search-poi';

/** One Overture place candidate (address already composed and non-empty). */
export interface OverturePlace {
	id: string;
	name: string | null;
	latitude: number;
	longitude: number;
	address: string;
}

/** The minimum a streamed place needs for the generic nearest-name-related match. */
export interface MatchablePlace {
	name: string | null;
	latitude: number;
	longitude: number;
}

/** An OSM staging POI as the matcher sees it (name + coordinates + identity). */
export interface MatchablePoi {
	osm_id: string;
	name: string | null;
	latitude: number;
	longitude: number;
}

/** An OSM staging POI that lacks a usable address (the address pass's work set). */
export type AddresslessPoi = MatchablePoi;

/** One POI's best (nearest name-related) place, with the full place attached. */
export interface NearestPlaceMatch<P extends MatchablePlace> {
	osm_id: string;
	place: P;
	/** Exact haversine metres — callers round as they store. */
	distance_m: number;
}

/** A proposed address fill for one POI, with provenance for citation. */
export interface OvertureMatch {
	osm_id: string;
	address: string;
	/** Provenance label, e.g. "overture:<id> (2026-06-17.0)". */
	address_source: string;
	distance_m: number;
}

// Cell ≈ 500 m, comfortably larger than any sane match radius, so a place only
// needs to probe the handful of cells its search box overlaps.
const CELL_DEG = 0.005;

/**
 * True when two normalised names plausibly refer to the same venue. Looser than
 * search_poi's dedup rule on purpose: matching is anchored by tight proximity, so
 * a short brand token (min 3 chars, e.g. "kfc") contained in the other name is
 * enough — that lets "KFC" match "Taco Bell / KFC". Both inputs must be normalised.
 */
export function nameRelated(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	return short.length >= 3 && long.includes(short);
}

/**
 * Composes a single-line address from Overture address parts (null if all empty).
 * Delegates to the canonical {@link composeAddressLine} so Overture-sourced
 * staging strings render in the same `…, REGION postcode` format as OSM-sourced
 * ones and the app's display addresses.
 */
export function composeOvertureAddress(parts: {
	freeform?: string | null;
	locality?: string | null;
	region?: string | null;
	postcode?: string | null;
}): string | null {
	return composeAddressLine({
		street: parts.freeform,
		city: parts.locality,
		region: parts.region,
		postcode: parts.postcode
	});
}

/**
 * The generic matching core: for each POI, finds the nearest name-related place
 * within `radiusM` and returns it with the FULL place attached, so a caller can
 * take whatever fields it needs (address, contacts, category, …). POIs with no
 * match are simply absent from the result. Matching semantics are exactly the
 * original address pass's: nearest name-related within radius.
 */
export async function matchNearestPlaces<P extends MatchablePlace>(
	pois: MatchablePoi[],
	places: Iterable<P> | AsyncIterable<P>,
	radiusM: number
): Promise<NearestPlaceMatch<P>[]> {
	const radiusKm = radiusM / 1000;

	// Index the POIs (the smaller, fixed set) once; stream places past them —
	// async so a country-scale cache (millions of lines, ~1 GB) can be streamed
	// from disk rather than materialized in memory.
	const grid = new SpatialGrid(CELL_DEG);
	pois.forEach((poi, i) => grid.insert(i, poi.latitude, poi.longitude));

	const best = new Map<number, { place: P; dist: number }>();
	for await (const place of places) {
		const placeName = normalizeName(place.name);
		const box = bboxAround(place.latitude, place.longitude, radiusKm);
		for (const idx of grid.candidatesInBbox(box)) {
			const poi = pois[idx];
			if (!nameRelated(normalizeName(poi.name), placeName)) continue;
			const dist = haversineMeters(poi.latitude, poi.longitude, place.latitude, place.longitude);
			if (dist > radiusM) continue;
			const prev = best.get(idx);
			if (!prev || dist < prev.dist) best.set(idx, { place, dist });
		}
	}

	const matches: NearestPlaceMatch<P>[] = [];
	for (const [idx, m] of best) {
		matches.push({ osm_id: pois[idx].osm_id, place: m.place, distance_m: m.dist });
	}
	return matches;
}

/**
 * For each address-less POI, finds the nearest name-related Overture place within
 * `radiusM` and returns the address to fill (with provenance). POIs with no match
 * are simply absent from the result. `releaseLabel` (the Overture release id) is
 * baked into each `address_source` so the citation records which snapshot it came
 * from. A thin address-shaped wrapper over {@link matchNearestPlaces}.
 */
export async function matchOverturePlaces(
	pois: AddresslessPoi[],
	places: Iterable<OverturePlace> | AsyncIterable<OverturePlace>,
	opts: { radiusM: number; releaseLabel: string }
): Promise<OvertureMatch[]> {
	async function* addressed(): AsyncGenerator<OverturePlace> {
		for await (const place of places) if (place.address) yield place;
	}
	const matches = await matchNearestPlaces(pois, addressed(), opts.radiusM);
	return matches.map((m) => ({
		osm_id: m.osm_id,
		address: m.place.address,
		address_source: `overture:${m.place.id} (${opts.releaseLabel})`,
		distance_m: Math.round(m.distance_m)
	}));
}
