// ---------------------------------------------------------------------------
// Overture release-pair closure signals (issue #302): a READ-ONLY worklist
// builder that diffs two snapshots of the Canada eateries fetch
// (scripts/overture/fetch-canada-eateries.py) against the staging store's
// banked Overture identities and flags venues that LOOK closed.
//
//   bun run overture:closure-signals --old data/overture-canada-eateries.2026-06-17.0.ndjson \
//     --new data/overture-canada-eateries.<next>.ndjson
//
// Why release-pair diffs: Overture's operating_status is effectively EMPTY in
// Canada (the 2026-07-10 experiment found 137 non-null of ~162k rows), so
// closure evidence has to come from what a place DOES between releases —
// vanish from the feed, or collapse in confidence — rather than from a status
// field. Three signals per banked staging POI (osm_poi.overture_id, banked by
// bun run overture:enrich):
//   • gone — the banked id is present in --old but absent from --new. GERS ids
//     are meant to be stable, but a churn incident (Nov-2025) re-minted ids at
//     scale, so a "gone" id whose venue REAPPEARS in --new under a different id
//     at the same spot with a name-related name is downgraded to `id_churn`
//     (an id lifecycle event, not a closure).
//   • confidence_collapse — the place's confidence dropped ≥ 0.2 between the
//     snapshots (Overture's existence-confidence deflating as its sources stop
//     corroborating the venue).
//   • status_closed — --new says operating_status = "permanently_closed" (rare
//     in Canada, but definitive when present).
//
// Two sanity guards protect against a pathological pair: a DIRECTION check
// (banked-id coverage of --new materially below --old means the arguments are
// swapped and every signal would be inverted; abort, --allow-swapped to
// override) and a MASS-FIRE check (any one signal flagging >10% of banked POIs
// is a recalibration/churn event, not real closures; abort before writing,
// --allow-mass-signals to override — the enrich pass's --allow-mass-clear
// precedent).
//
// Flagged POIs are mapped to live venues via locations.osm_id (migration 0028)
// with the same read-only HTTP-D1 access as scripts/backfill-osm-id.ts — one
// SELECT, no writes, EVER: the output is a worklist for the existing
// verify-then-close_location workflow (a human/agent confirms each closure
// against the venue's own site / Google / Yelp before calling close_location).
// POIs with no live venue are still reported (grouped `staging_only`) — they
// are staleness intel for the staging store and future imports.
//
// Only ONE release snapshot exists on disk today, so this script's first real
// run awaits the next Overture release (keep both files per issue #304:
// refetch with fetch-canada-eateries.py, keeping the old NDJSON). The planning
// core is pure and unit-tested against synthetic snapshot fixtures instead
// (closure-signals.test.ts) — that is expected, not a gap.
// ---------------------------------------------------------------------------

import { createHttpD1 } from '../../src/lib/server/d1-http';
import { OsmPoiStore } from '../osm/poi-store';
import { matchNearestPlaces } from './match-overture';

/** The slice of one snapshot line the diff needs (see fetch-canada-eateries.py). */
export interface SnapshotPlace {
	id: string;
	name: string | null;
	latitude: number;
	longitude: number;
	confidence: number | null;
	operating_status: string | null;
}

/** A staging POI with a banked Overture identity (osm_poi.overture_id NOT NULL). */
export interface BankedPoi {
	osm_id: string;
	name: string | null;
	latitude: number;
	longitude: number;
	overture_id: string;
}

export type ClosureSignalType = 'gone' | 'id_churn' | 'confidence_collapse' | 'status_closed';

/** The same-spot, name-related --new place a `gone` id reappeared under. */
export interface ChurnCandidate {
	overture_id: string;
	name: string | null;
	distance_m: number;
	confidence: number | null;
	operating_status: string | null;
}

/** One flagged POI under one signal (a POI may fire several signals). */
export interface ClosureSignal {
	signal: ClosureSignalType;
	osm_id: string;
	poi_name: string | null;
	/** The staging POI's (OSM-verbatim) coordinates — where to look when verifying. */
	latitude: number;
	longitude: number;
	overture_id: string;
	/** The place's name as the snapshots carry it (old wins; new as fallback). */
	overture_name: string | null;
	evidence: {
		old_confidence: number | null;
		new_confidence: number | null;
		old_status: string | null;
		new_status: string | null;
		/** id_churn only: the replacement identity the venue reappeared under. */
		churn_candidate?: ChurnCandidate;
	};
}

export interface ClosurePlan {
	signals: ClosureSignal[];
	counts: {
		banked: number;
		in_old: number;
		in_new: number;
		/**
		 * Banked ids in NEITHER snapshot — unevaluable here (the bank ran against
		 * a different release than --old, or the fetch bbox moved). Re-run
		 * overture:enrich against --new before trusting a high count.
		 */
		in_neither: number;
		gone: number;
		id_churn: number;
		confidence_collapse: number;
		status_closed: number;
	};
}

export const DEFAULT_CONFIDENCE_DROP = 0.2;
/** Same radius as the enrichment match — "the same spot" for the churn check. */
export const DEFAULT_CHURN_RADIUS_M = 100;

/**
 * Mass-fire sanity threshold, PER SIGNAL TYPE: when any one signal flags more
 * than this fraction of the banked POIs, the release pair is almost certainly
 * pathological — a global confidence recalibration (Overture's 2026-03
 * incident) inflates confidence_collapse alone, a GERS churn event inflates
 * gone/id_churn alone — not tens of thousands of real closures. Per-signal so
 * one runaway signal can't hide inside an otherwise-quiet total. A real run
 * must abort before writing the worklist (overridable with
 * --allow-mass-signals), mirroring overture:enrich's --allow-mass-clear.
 */
export const MASS_SIGNAL_FRACTION = 0.1;

const SIGNAL_TYPES: ClosureSignalType[] = [
	'gone',
	'id_churn',
	'confidence_collapse',
	'status_closed'
];

/** The first signal type whose count trips {@link MASS_SIGNAL_FRACTION}, or null. */
export function massSignalsExceeded(counts: ClosurePlan['counts']): ClosureSignalType | null {
	if (counts.banked === 0) return null;
	return SIGNAL_TYPES.find((t) => counts[t] / counts.banked > MASS_SIGNAL_FRACTION) ?? null;
}

/**
 * Direction sanity margin: the bank is (re)built against the CURRENT release
 * (the operational flow runs overture:enrich on --new first), so banked ids
 * must cover --new at least as well as --old — real churn + closures only
 * shave a few percent off. Coverage of --new falling more than this fraction
 * BELOW --old is the signature of swapped arguments, whose whole output would
 * be silently inverted (openings read as closures). 5%: comfortably above one
 * release's genuine attrition, far below the asymmetry a real swap shows.
 */
export const SWAP_COVERAGE_MARGIN = 0.05;

/** True when banked-id coverage says --old/--new look swapped (see {@link SWAP_COVERAGE_MARGIN}). */
export function snapshotsLookSwapped(
	counts: Pick<ClosurePlan['counts'], 'in_old' | 'in_new'>
): boolean {
	return counts.in_new < counts.in_old * (1 - SWAP_COVERAGE_MARGIN);
}

/**
 * The pure planning core: diffs the two snapshots for every banked POI and
 * returns each triggered signal with its evidence. Absent-from-new ids go
 * through the churn check (nearest name-related --new place within
 * `churnRadiusM` of the OLD place's spot) before being called `gone` — the
 * Nov-2025 GERS churn incident makes a bare id disappearance closure evidence
 * only when nothing name-related replaces it. Never touches a database.
 */
export async function planClosureSignals(
	pois: BankedPoi[],
	oldPlaces: SnapshotPlace[],
	newPlaces: SnapshotPlace[],
	opts: { confidenceDrop?: number; churnRadiusM?: number } = {}
): Promise<ClosurePlan> {
	const confidenceDrop = opts.confidenceDrop ?? DEFAULT_CONFIDENCE_DROP;
	const churnRadiusM = opts.churnRadiusM ?? DEFAULT_CHURN_RADIUS_M;
	const oldById = new Map(oldPlaces.map((p) => [p.id, p]));
	const newById = new Map(newPlaces.map((p) => [p.id, p]));

	const counts: ClosurePlan['counts'] = {
		banked: pois.length,
		in_old: 0,
		in_new: 0,
		in_neither: 0,
		gone: 0,
		id_churn: 0,
		confidence_collapse: 0,
		status_closed: 0
	};
	const signals: ClosureSignal[] = [];
	const emit = (
		signal: ClosureSignalType,
		poi: BankedPoi,
		oldP: SnapshotPlace | null,
		newP: SnapshotPlace | null,
		churn?: ChurnCandidate
	): void => {
		counts[signal]++;
		signals.push({
			signal,
			osm_id: poi.osm_id,
			poi_name: poi.name,
			latitude: poi.latitude,
			longitude: poi.longitude,
			overture_id: poi.overture_id,
			overture_name: oldP?.name ?? newP?.name ?? null,
			evidence: {
				old_confidence: oldP?.confidence ?? null,
				new_confidence: newP?.confidence ?? null,
				old_status: oldP?.operating_status ?? null,
				new_status: newP?.operating_status ?? null,
				...(churn ? { churn_candidate: churn } : {})
			}
		});
	};

	// First pass: everything decidable from the id lookups alone. Ids absent
	// from --new are parked for the (spatial) churn check below.
	const goneCandidates: { poi: BankedPoi; oldP: SnapshotPlace }[] = [];
	for (const poi of pois) {
		const oldP = oldById.get(poi.overture_id) ?? null;
		const newP = newById.get(poi.overture_id) ?? null;
		if (oldP) counts.in_old++;
		if (newP) counts.in_new++;
		if (!oldP && !newP) {
			counts.in_neither++;
			continue;
		}
		if (newP) {
			// Both signals may fire on one POI (a closing venue often collapses in
			// confidence too) — each rides its own worklist group.
			if (newP.operating_status === 'permanently_closed') {
				emit('status_closed', poi, oldP, newP);
			}
			if (
				oldP !== null &&
				oldP.confidence !== null &&
				newP.confidence !== null &&
				oldP.confidence - newP.confidence >= confidenceDrop
			) {
				emit('confidence_collapse', poi, oldP, newP);
			}
		} else if (oldP) {
			goneCandidates.push({ poi, oldP });
		}
	}

	// Churn check: probe --new around each vanished place's OLD spot/name (the
	// same nearest-name-related matching the enrichment pass uses). A hit means
	// the venue is still in the feed under a re-minted id — id_churn, not gone.
	//
	// The donor pool is FRESH ids only — new-snapshot places absent from --old.
	// A re-mint is by definition a fresh id; a candidate present in BOTH
	// snapshots is a stable NEIGHBOUR, and letting it "replace" the vanished id
	// suppresses real closures (a branch closing near a same-brand sibling —
	// mall + street pairs, a "Wendy's / Tim Hortons" co-brand 78 m away — or a
	// short-brand substring relation like "Pizza and Wings" ⊃ "A&W"). A fresh id
	// that --new itself marks permanently_closed can't stand in for a live venue
	// either. Residual ambiguity, accepted: a chain closing one unit while a NEW
	// nearby unit opens under a fresh id in the same release still reads as
	// churn — the verify-then-close_location workflow catches that case.
	const probes = goneCandidates.map(({ poi, oldP }) => ({
		osm_id: poi.osm_id,
		name: oldP.name,
		latitude: oldP.latitude,
		longitude: oldP.longitude
	}));
	const freshPlaces = newPlaces.filter(
		(p) => !oldById.has(p.id) && p.operating_status !== 'permanently_closed'
	);
	const churnMatches = await matchNearestPlaces(probes, freshPlaces, churnRadiusM);
	const churnByOsmId = new Map(churnMatches.map((m) => [m.osm_id, m]));
	for (const { poi, oldP } of goneCandidates) {
		const m = churnByOsmId.get(poi.osm_id);
		if (m) {
			emit('id_churn', poi, oldP, null, {
				overture_id: m.place.id,
				name: m.place.name,
				distance_m: Math.round(m.distance_m),
				confidence: m.place.confidence,
				operating_status: m.place.operating_status
			});
		} else {
			emit('gone', poi, oldP, null);
		}
	}

	return { signals, counts };
}

/** A live-D1 venue keyed by its osm_id (SELECT id, name, osm_id, closed_at). */
export interface LocationRef {
	id: string;
	name: string;
	closed: boolean;
}

export interface WorklistEntry extends ClosureSignal {
	/** The mapped venue — present in the `live` and `already_closed` groups. */
	location?: { id: string; name: string };
}

type SignalGroups = Record<ClosureSignalType, WorklistEntry[]>;

export interface ClosureWorklist {
	generated_at: string;
	old_snapshot: string;
	new_snapshot: string;
	confidence_drop: number;
	churn_radius_m: number;
	counts: ClosurePlan['counts'] & {
		/** Signal entries per disposition (a POI firing two signals counts twice). */
		live_location: number;
		already_closed_location: number;
		staging_only: number;
	};
	/**
	 * Signals mapped to a LIVE map venue — the actionable worklist. Verify each
	 * against the venue's own site / Google / Yelp, then close_location (id +
	 * evidence as the reason). This script never closes anything itself.
	 */
	live: SignalGroups;
	/** Signals on venues already closed on the map — no action, kept for analysis. */
	already_closed: SignalGroups;
	/**
	 * Signals on staging POIs with no map venue — staleness intel: check these
	 * before importing (a `gone` staging POI is a likely tombstone candidate).
	 */
	staging_only: SignalGroups;
}

const emptyGroups = (): SignalGroups => ({
	gone: [],
	id_churn: [],
	confidence_collapse: [],
	status_closed: []
});

/**
 * Pure grouping step: joins each signal to its venue (via osm_id) and buckets
 * it by disposition (live / already_closed / staging_only) and signal type —
 * the JSON the CLI writes, minus nothing.
 */
export function buildWorklist(
	plan: ClosurePlan,
	locationsByOsmId: Map<string, LocationRef>,
	meta: {
		oldSnapshot: string;
		newSnapshot: string;
		confidenceDrop: number;
		churnRadiusM: number;
		generatedAt?: string;
	}
): ClosureWorklist {
	const live = emptyGroups();
	const alreadyClosed = emptyGroups();
	const stagingOnly = emptyGroups();
	const counts = { live_location: 0, already_closed_location: 0, staging_only: 0 };
	for (const signal of plan.signals) {
		const loc = locationsByOsmId.get(signal.osm_id);
		if (!loc) {
			counts.staging_only++;
			stagingOnly[signal.signal].push(signal);
		} else if (loc.closed) {
			counts.already_closed_location++;
			alreadyClosed[signal.signal].push({ ...signal, location: { id: loc.id, name: loc.name } });
		} else {
			counts.live_location++;
			live[signal.signal].push({ ...signal, location: { id: loc.id, name: loc.name } });
		}
	}
	return {
		generated_at: meta.generatedAt ?? new Date().toISOString(),
		old_snapshot: meta.oldSnapshot,
		new_snapshot: meta.newSnapshot,
		confidence_drop: meta.confidenceDrop,
		churn_radius_m: meta.churnRadiusM,
		counts: { ...plan.counts, ...counts },
		live,
		already_closed: alreadyClosed,
		staging_only: stagingOnly
	};
}

/** Maps one raw eateries-NDJSON record to a {@link SnapshotPlace} (null = unusable). */
export function toSnapshotPlace(raw: unknown): SnapshotPlace | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const r = raw as {
		id?: unknown;
		name?: unknown;
		lon?: unknown;
		lat?: unknown;
		confidence?: unknown;
		operating_status?: unknown;
	};
	if (typeof r.id !== 'string' || typeof r.lon !== 'number' || typeof r.lat !== 'number') {
		return null;
	}
	return {
		id: r.id,
		name: typeof r.name === 'string' ? r.name : null,
		latitude: r.lat,
		longitude: r.lon,
		confidence: typeof r.confidence === 'number' ? r.confidence : null,
		operating_status: typeof r.operating_status === 'string' ? r.operating_status : null
	};
}

/**
 * Streams a snapshot NDJSON into slim {@link SnapshotPlace}s (a country-scale
 * file runs to hundreds of MB — never materialize the raw text). Malformed
 * lines are skipped, mirroring overture-enrich's reader.
 */
async function readSnapshot(path: string): Promise<SnapshotPlace[]> {
	const places: SnapshotPlace[] = [];
	const decoder = new TextDecoder();
	let buf = '';
	const take = (line: string): void => {
		if (!line.trim()) return;
		try {
			const place = toSnapshotPlace(JSON.parse(line));
			if (place) places.push(place);
		} catch {
			// skip malformed line
		}
	};
	const stream = Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>;
	for await (const chunk of stream) {
		buf += decoder.decode(chunk, { stream: true });
		let nl = buf.indexOf('\n');
		while (nl >= 0) {
			take(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
			nl = buf.indexOf('\n');
		}
	}
	buf += decoder.decode();
	take(buf);
	return places;
}

interface Args {
	old: string;
	new: string;
	db: string;
	out: string;
	confidenceDrop: number;
	churnRadiusM: number;
	allowMassSignals: boolean;
	allowSwapped: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Partial<Args> = {
		db: process.env.OSM_POI_DB ?? 'data/osm-poi.sqlite',
		out: 'data/closure-signals.worklist.json',
		confidenceDrop: DEFAULT_CONFIDENCE_DROP,
		churnRadiusM: DEFAULT_CHURN_RADIUS_M,
		allowMassSignals: false,
		allowSwapped: false
	};
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case '--old':
				args.old = argv[++i];
				break;
			case '--new':
				args.new = argv[++i];
				break;
			case '--db':
				args.db = argv[++i];
				break;
			case '--out':
				args.out = argv[++i];
				break;
			case '--confidence-drop':
				args.confidenceDrop = Number(argv[++i]);
				break;
			case '--churn-radius-m':
				args.churnRadiusM = Number(argv[++i]);
				break;
			case '--allow-mass-signals':
				args.allowMassSignals = true;
				break;
			case '--allow-swapped':
				args.allowSwapped = true;
				break;
			case '--help':
			case '-h':
				printUsageAndExit(0);
				break;
			default:
				console.error(`Unknown argument: ${argv[i]}`);
				printUsageAndExit(1);
		}
	}
	if (!args.old || !args.new) {
		console.error('Error: --old and --new are both required.\n');
		printUsageAndExit(1);
	}
	if (!Number.isFinite(args.confidenceDrop) || (args.confidenceDrop ?? 0) <= 0) {
		console.error('Error: --confidence-drop must be a positive number.\n');
		printUsageAndExit(1);
	}
	if (!Number.isFinite(args.churnRadiusM) || (args.churnRadiusM ?? 0) <= 0) {
		console.error('Error: --churn-radius-m must be a positive number.\n');
		printUsageAndExit(1);
	}
	return args as Args;
}

function printUsageAndExit(code: number): never {
	console.error(
		'Usage: bun run overture:closure-signals --old <eateries.ndjson> --new <eateries.ndjson>\n' +
			'         [--db <osm-poi.sqlite>] [--out <worklist.json>]\n' +
			'         [--confidence-drop <n>] [--churn-radius-m <m>]\n' +
			'\n' +
			'  --old / --new       Two release snapshots of the eateries fetch (same schema;\n' +
			'                      built by scripts/overture/fetch-canada-eateries.py — keep the\n' +
			'                      previous release on disk per issue #304).\n' +
			'  --db                Staging SQLite path (default: data/osm-poi.sqlite or $OSM_POI_DB).\n' +
			'  --out               Worklist JSON path (default: data/closure-signals.worklist.json).\n' +
			`  --confidence-drop   Confidence-collapse threshold (default ${DEFAULT_CONFIDENCE_DROP}).\n` +
			`  --churn-radius-m    Same-spot radius for the id-churn downgrade (default ${DEFAULT_CHURN_RADIUS_M}).\n` +
			`  --allow-mass-signals  Proceed although one signal type flags more than ` +
			`${Math.round(MASS_SIGNAL_FRACTION * 100)}% of banked POIs\n` +
			'                      (normally the tell of a pathological release pair — a global\n' +
			'                      confidence recalibration or a GERS churn event).\n' +
			'  --allow-swapped     Proceed although banked-id coverage says --old/--new look swapped\n' +
			'                      (coverage of --new materially below --old).\n' +
			'\n' +
			'Read-only everywhere: reads the staging store and the live D1, writes ONLY the\n' +
			'worklist file. Closures happen later, via verify-then-close_location.\n'
	);
	process.exit(code);
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	for (const path of [args.old, args.new]) {
		if (!(await Bun.file(path).exists())) {
			console.error(`Error: snapshot not found: ${path}`);
			process.exit(1);
		}
	}

	const store = OsmPoiStore.openReadonly(args.db);
	const pois: BankedPoi[] = store
		.contactEnrichmentPois()
		.filter((p): p is typeof p & { overture_id: string } => p.overture_id !== null)
		.map((p) => ({
			osm_id: p.osm_id,
			name: p.name,
			latitude: p.latitude,
			longitude: p.longitude,
			overture_id: p.overture_id
		}));
	store.close();
	console.error(`Staging POIs with a banked overture_id: ${pois.length}`);

	const [oldPlaces, newPlaces] = await Promise.all([
		readSnapshot(args.old),
		readSnapshot(args.new)
	]);
	console.error(`Snapshot places: ${oldPlaces.length} old, ${newPlaces.length} new`);
	if (newPlaces.length < oldPlaces.length * 0.9) {
		// Advisory only — the authoritative direction check is the banked-id
		// coverage comparison below (feeds legitimately shrink a little).
		console.error(
			`Warning: --new carries ${oldPlaces.length - newPlaces.length} fewer places than --old ` +
				`(>10% drop) — double-check the snapshot order and the fetch bbox.`
		);
	}

	// The one D1 touch: the osm_id → venue identity join, read-only (the same
	// HTTP-D1 access pattern as scripts/backfill-osm-id.ts). Closed rows ride
	// along so a signal on an already-closed venue is filed, not re-worked.
	const db = createHttpD1();
	const { results: locations } = await db
		.prepare(`SELECT id, name, osm_id, closed_at FROM locations WHERE osm_id IS NOT NULL`)
		.bind()
		.all<{ id: string; name: string; osm_id: string; closed_at: number | null }>();
	const locationsByOsmId = new Map<string, LocationRef>(
		locations.map((l) => [l.osm_id, { id: l.id, name: l.name, closed: l.closed_at !== null }])
	);

	const plan = await planClosureSignals(pois, oldPlaces, newPlaces, {
		confidenceDrop: args.confidenceDrop,
		churnRadiusM: args.churnRadiusM
	});

	// Direction sanity FIRST: on a swapped pair every downstream number is
	// inverted (openings read as closures), so nothing else is worth printing.
	if (snapshotsLookSwapped(plan.counts)) {
		const detail =
			`banked-id coverage of --new (${plan.counts.in_new}/${plan.counts.banked}) is materially ` +
			`below --old (${plan.counts.in_old}/${plan.counts.banked}) — the bank tracks the current ` +
			`release, so the snapshots look SWAPPED (--old should be the earlier release).`;
		if (!args.allowSwapped) {
			console.error(
				`Error: ${detail} Re-run with the arguments the right way round, or pass ` +
					`--allow-swapped if this pair is genuinely this asymmetric.`
			);
			process.exit(1);
		}
		console.error(`Warning: ${detail} Proceeding (--allow-swapped).`);
	}

	// Mass-fire sanity: a pathological pair (global confidence recalibration,
	// GERS churn event) floods one signal type with tens of thousands of
	// "candidates" no one can work — abort before writing that worklist.
	const massSignal = massSignalsExceeded(plan.counts);
	if (massSignal !== null) {
		const detail =
			`signal "${massSignal}" flagged ${plan.counts[massSignal]} of ${plan.counts.banked} banked ` +
			`POIs (>${Math.round(MASS_SIGNAL_FRACTION * 100)}%) — a release-pair pathology (confidence ` +
			`recalibration / GERS churn event), not that many real closures.`;
		if (!args.allowMassSignals) {
			console.error(`Error: ${detail} Pass --allow-mass-signals to write the worklist anyway.`);
			process.exit(1);
		}
		console.error(`Warning: ${detail} Proceeding (--allow-mass-signals).`);
	}

	const worklist = buildWorklist(plan, locationsByOsmId, {
		oldSnapshot: args.old,
		newSnapshot: args.new,
		confidenceDrop: args.confidenceDrop,
		churnRadiusM: args.churnRadiusM
	});
	await Bun.write(args.out, JSON.stringify(worklist, null, '\t') + '\n');

	const c = worklist.counts;
	console.error(`\nBanked ids in old/new/neither:  ${c.in_old} / ${c.in_new} / ${c.in_neither}`);
	console.error(`gone:                           ${c.gone}`);
	console.error(`id_churn (downgraded):          ${c.id_churn}`);
	console.error(`confidence_collapse:            ${c.confidence_collapse}`);
	console.error(`status_closed:                  ${c.status_closed}`);
	console.error(
		`Dispositions: ${c.live_location} live venue, ${c.already_closed_location} already closed, ` +
			`${c.staging_only} staging-only`
	);
	console.error(
		`\nWorklist written to ${args.out} — verify each, then close_location. No writes made.`
	);
}

// Only run as a CLI — the planning core is imported by tests.
if (import.meta.main) await main();
