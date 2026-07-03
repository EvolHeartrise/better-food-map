// Screen-space layout for the map's venue-name labels.
//
// The map draws every venue as a black-on-white name pill "magnetized" to its
// projected origin — there are no marker dots. The geometry lives here, framework
// -free, so it can be unit-tested and kept out of the Svelte component, which is
// left as thin glue around `LabelEngine`:
//
//   • `selectVisible` decides WHICH pills to show at the current zoom: per cell of
//     an absolute geographic lattice, the highest-priority `perCell` labels survive
//     and the rest hide. Because the lattice shrinks (in degrees) as the user zooms
//     in, more labels win a cell at higher zoom — that is how names reveal
//     progressively without ever drawing a dot.
//
//   • `fillFreeSpace` then re-admits grid losers whose overlap the force sim can
//     RESOLVE: the grid bounds density but is blind to actual room, so without this
//     pass two venues sharing a cell always cost one its pill — even two co-located
//     mall stalls whose pills merely need a nudge apart. Admission is budgeted on
//     least-axis penetration (the sim's own separating move), with hysteresis
//     (entering is stricter than staying) because screen distances aren't
//     pan-invariant on the globe.
//
//   • `stepSimulation` advances the force model one frame: every pill is pulled
//     strongly toward its origin (a spring), so it wants to sit centred on its venue's
//     coordinate, and is pushed off a neighbour ONLY where their boxes would actually
//     overlap (an axis-aligned collision), by the least amount that separates them — so a
//     knot of nearby venues nudges just far enough apart to never overlap and otherwise
//     stays put on its point. There are no connector/leader lines.
//
//   • `LabelEngine` owns the persistent per-pill state across frames and ties the
//     two together: `recompute` re-picks the visible set, `tick` re-projects and
//     advances it, and `attach`/`detach` bind the rendered DOM elements.

/** A candidate label's absolute-lattice cell and tie-break priority, for decluttering. */
export type LabelAnchor = {
	id: string;
	// The venue's cell on the absolute geographic lattice — integer indices of its lng/lat
	// quantized by the declutter cell size (see LabelEngine.recompute). Pan-invariant
	// because the venue's coordinate doesn't move when the camera pans; only zoom (which
	// resizes the cells) changes these.
	cellX: number;
	cellY: number;
	// Higher wins when two anchors fall in the same cell and only some survive (the
	// selected venue uses Infinity so it is never decluttered away).
	priority: number;
};

/**
 * A live pill in the force simulation. Positions are CSS pixels. The pill is
 * stored as an OFFSET (`ox`, `oy`) from its anchor, not an absolute screen point —
 * the spring and collision act only on that offset, so a map pan (which moves every
 * anchor rigidly each frame) translates the pill instantly via `anchor + offset`
 * and never feeds the spring. That is what keeps pills locked to the map while
 * panning; only the relative spread animates.
 */
export type SimNode = {
	id: string;
	// Anchor (origin) — refreshed every frame from the live projection.
	ax: number;
	ay: number;
	// Pill-centre offset from the anchor.
	ox: number;
	oy: number;
	// The net change in (ox, oy) on the last simulation step, written by stepSimulation.
	// The caller reads vx²+vy² as the pill's movement to tell when the layout has settled.
	vx: number;
	vy: number;
	// Half the measured pill width/height, used as the pill's collision extent.
	hw: number;
	hh: number;
};

export type SimConfig = {
	// How far a pill is eased back toward its origin each frame, as a fraction (0–1) of
	// the remaining offset. Kept strong so an unobstructed pill hugs its venue's
	// coordinate and only sits off it where a neighbour's collision holds it away.
	spring: number;
	// Fraction of the box penetration each collision pass removes (0–1); a few passes
	// (see COLLISION_PASSES) then converge so that, at rest, no two boxes overlap.
	separation: number;
	// Breathing room kept between pill boxes, in px: the collision treats each box as if
	// grown by this much, so pills settle a hair apart rather than exactly edge-to-edge.
	padding: number;
	// Hard cap on how far a pill may be pushed from its origin, in px — a backstop so an
	// over-constrained spot can't fling a pill far from its coordinate.
	maxLeader: number;
};

// How many position-based collision passes stepSimulation runs per frame. Each pass
// removes `separation` of any remaining box penetration, so a few converge to clear.
const COLLISION_PASSES = 4;

/**
 * The geographic cell size, in DEGREES, whose on-screen width is ≈ `targetPx` CSS pixels
 * at MapLibre `zoom`. MapLibre's world is `512 · 2^zoom` px around, so a full 360° of
 * longitude spans that many pixels and `targetPx` of them subtend this many degrees. The
 * declutter lattice is sized from the zoom this way, then bucketed in lng/lat (see
 * {@link selectVisible}) — so at a fixed zoom the lattice is fixed and a pan never moves a
 * venue between cells, while zooming rescales it for the progressive reveal. Feed it a
 * jitter-held zoom ({@link holdZoom}), not the raw camera zoom: a globe pan wobbles the
 * reported zoom by ~±0.0004, which would otherwise resize the cell every frame and flicker
 * boundary labels. Approximate near the poles / on the curved globe, but that only nudges
 * DENSITY; the absolute lat/lng lattice is what guarantees pan-stability, on any projection.
 */
export function geoCellDegrees(zoom: number, targetPx: number): number {
	return (targetPx * 360) / (512 * 2 ** zoom);
}

/**
 * Hold a zoom value steady against jitter: return `held` unchanged unless `live` has moved
 * at least `threshold` from it, in which case adopt `live`. The zoom MapLibre reports during
 * a globe pan micro-jitters (~±0.0004); sizing the declutter cell from the raw value would
 * wobble the lattice and flip labels in and out at cell boundaries every frame (the data
 * that diagnosed this showed the candidate set unchanged while the visible set churned with
 * a ±0.0004 zoom wander). Sourcing the cell zoom through this — with a `threshold` far above
 * the jitter but below a deliberate zoom step — keeps the lattice fixed through a pan and
 * resizes only on a real zoom. Stateless: the caller holds the running value and passes it
 * back in. Seed `held` at any value (a large first delta adopts the real zoom immediately).
 */
export function holdZoom(held: number, live: number, threshold: number): number {
	return Math.abs(live - held) >= threshold ? live : held;
}

/** Deterministic value in [0, 1) hashed from an id, for a stable tie-break. */
export function hashId(id: string): number {
	let h = 2166136261;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) / 4294967296;
}

/**
 * Grid decluttering over a pre-computed cell assignment: drop each anchor into its cell
 * (the integer `cellX`/`cellY` the caller stamped on it), keep the highest-`priority`
 * `perCell` within each, then, if more than `max` survive overall, keep the top `max` by
 * priority. This bounds label DENSITY uniformly (≈`perCell` per cell everywhere)
 * regardless of how the underlying venues clump, so a dense downtown shows the same
 * labels-per-area as a sparse suburb.
 *
 * The cells are an absolute GEOGRAPHIC lattice (lng/lat quantized in {@link
 * LabelEngine.recompute}), NOT a screen-space one. That is what makes the kept set
 * pan-invariant on the GLOBE projection as well as flat Mercator: a venue's lng/lat never
 * moves when the camera pans, so its cell — and whether it wins that cell — is unchanged
 * as the map slides, and labels don't flicker in and out at cell boundaries. (A
 * screen-space lattice is only pan-invariant under an affine projection; the globe, where
 * a pan is a sphere rotation, is not affine — which is the trap an earlier version fell
 * into.) Only ZOOM resizes the lattice, moving venues between cells — the progressive
 * reveal, mirroring the shared absolute lattice in $lib/grid.
 *
 * Bucketing on a fixed grid is O(n) (one cell lookup per anchor) and, crucially, caps
 * the number of pills handed to the force simulation, so an over-dense viewport can't
 * hand it an unsatisfiable packing that never settles. Input order doesn't matter —
 * within-cell selection and the global trim are both by descending priority. Pass
 * `perCell: Infinity` to disable per-cell thinning entirely (bounded only by `max`).
 */
export function selectVisible(anchors: LabelAnchor[], perCell: number, max: number): Set<string> {
	// Bucket anchors by their absolute geographic cell (stamped by the caller). The cell
	// is a function of the venue's fixed coordinate only, so it doesn't move when the map
	// pans (on any projection) — only zooming, which resizes the cells, reshuffles.
	const cells = new Map<string, LabelAnchor[]>();
	for (const a of anchors) {
		const key = `${a.cellX},${a.cellY}`;
		let bucket = cells.get(key);
		if (!bucket) cells.set(key, (bucket = []));
		bucket.push(a);
	}

	// Keep the top `perCell` (by priority) within each cell.
	const kept: LabelAnchor[] = [];
	for (const bucket of cells.values()) {
		if (bucket.length > perCell) {
			bucket.sort((a, b) => b.priority - a.priority);
			for (let i = 0; i < perCell; i++) kept.push(bucket[i]);
		} else {
			for (const a of bucket) kept.push(a);
		}
	}

	// Global density backstop: if still over `max`, keep the highest-priority `max`.
	if (kept.length > max) {
		kept.sort((a, b) => b.priority - a.priority);
		kept.length = max;
	}

	return new Set(kept.map((a) => a.id));
}

// --- Free-space fill ---------------------------------------------------------
// The declutter grid guarantees bounded, pan-stable density, but it is blind to
// actual screen room: two venues sharing a grid cell always cost one of them its
// pill even when the force sim could easily lay both out. This second pass
// re-admits grid losers whose overlap the sim can RESOLVE — the grid stays the
// density GUARANTEE, the fill is opportunistic on top. Admission is budgeted on
// penetration, not clearance: two co-located venues (food stalls in a mall)
// never have clear anchor-to-anchor room at ANY reachable zoom, but their pills
// only overlap by a pill-height — exactly the least-penetration nudge
// stepSimulation resolves — so both show, sitting a little off their shared
// point. A pile-up beyond what the sim can spread stays hidden.

/** A pill's projected anchor + half-box, the unit the free-space fill packs. */
export type FillBox = {
	id: string;
	x: number;
	y: number;
	hw: number;
	hh: number;
	priority: number;
};

/**
 * Total penetration (px, summed over every shown pill it overlaps, each pair
 * measured on its least axis — the axis the sim separates along) a grid loser
 * may ADD and still be admitted by the free-space fill. This is the nudging an
 * admission asks of the layout: sized to admit a fully co-located PAIR even at
 * the unmeasured-box estimate (2 × {@link FILL_EST_HALF_H_PX} = 52), while a
 * third pill on the same point doubles the sum and stays out — so a mall pair
 * splits apart and shows, a food-court pile-up doesn't jostle forever. Well
 * inside the sim's maxLeader, so the resolving nudges stay near the anchors.
 */
export const FILL_ADMIT_BUDGET_PX = 56;
/**
 * The (looser) penetration an already-admitted pill may carry and STAY
 * admitted. The gap above {@link FILL_ADMIT_BUDGET_PX} is the hysteresis band:
 * screen-space penetration is NOT pan-invariant (on the globe a pan is a
 * sphere rotation, and even flat Mercator zoom scales it), so a pill that
 * barely qualified would otherwise flicker in and out as the camera slides
 * across the admission boundary. Entering is strict; only clearly-worse
 * overlap evicts.
 */
export const FILL_RETAIN_BUDGET_PX = 64;
/**
 * Half-box (px) assumed for a pill that has never been rendered, hence never
 * measured (the engine measures on DOM attach). Sized generously — a bit above
 * the typical two-line pill — so an estimate admission rarely turns out worse
 * once its real box lands; over-estimating only delays an admission by a
 * pass, while under-estimating admits a pill that then must be evicted.
 */
export const FILL_EST_HALF_W_PX = 76;
export const FILL_EST_HALF_H_PX = 26;

/**
 * How deeply two boxes interpenetrate on their LEAST axis (0 when apart) — the
 * separating nudge stepSimulation's collision pass would apply to the pair.
 */
function pairPenetration(a: FillBox, b: FillBox): number {
	const px = a.hw + b.hw - Math.abs(a.x - b.x);
	const py = a.hh + b.hh - Math.abs(a.y - b.y);
	return px > 0 && py > 0 ? Math.min(px, py) : 0;
}

/**
 * The grid losers to show anyway because the sim can lay them out: greedy
 * admission in descending priority order, each candidate charged the TOTAL
 * least-axis penetration its box adds against everything already shown and
 * admitted while under the budget. Previously-admitted pills (`prevAdmitted`)
 * re-qualify first, against the looser retain budget — the hysteresis that
 * keeps a pan from churning the admitted set, and lets an incumbent hold its
 * space against a higher-priority newcomer (churn again) — then new
 * admissions, each claiming their box before lower-priority candidates test
 * theirs. `budget` caps how many admissions may be added on top of the kept
 * set (the caller passes `max - kept`, so the global pill ceiling holds).
 * O(rest × shown) axis-aligned box tests, bounded by the payload caps
 * upstream. Greedy pairwise-at-anchor sums don't PROVE the final multi-pill
 * layout is overlap-free — the sim's settle backstop covers the rare
 * over-constrained cluster.
 */
export function fillFreeSpace(
	kept: FillBox[],
	rest: FillBox[],
	prevAdmitted: ReadonlySet<string>,
	budget: number
): Set<string> {
	const admitted = new Set<string>();
	if (budget <= 0) return admitted;
	const shown = [...kept];
	// Returning members first — an incumbent must not lose its spot to a newcomer
	// that packs the same space at higher priority mid-pan (that's churn, exactly
	// what the hysteresis exists to prevent) — then both groups by priority.
	const ordered = rest.toSorted(
		(a, b) =>
			Number(prevAdmitted.has(b.id)) - Number(prevAdmitted.has(a.id)) || b.priority - a.priority
	);
	for (const box of ordered) {
		if (admitted.size >= budget) break;
		const allowance = prevAdmitted.has(box.id) ? FILL_RETAIN_BUDGET_PX : FILL_ADMIT_BUDGET_PX;
		let need = 0;
		for (const s of shown) {
			need += pairPenetration(box, s);
			if (need > allowance) break;
		}
		if (need > allowance) continue;
		admitted.add(box.id);
		shown.push(box);
	}
	return admitted;
}

/**
 * Advance the pill positions one frame, mutating the nodes in place. Everything
 * operates on the anchor-relative offset (`ox`, `oy`): the spring pulls it toward
 * zero and collisions push it outward, so the rigid component of any camera motion
 * (a pan re-projecting every anchor by the same delta) never enters the dynamics.
 *
 * The model is a position-based relaxation with two parts, run each frame:
 *   1. a STRONG spring that eases every pill a fraction of the way back onto its origin,
 *      so an unobstructed pill homes right onto its venue's coordinate; and
 *   2. a COLLISION pass that, wherever two padded boxes would overlap, moves the pair
 *      directly apart along their least-penetration axis (the smallest nudge that clears
 *      them) -- so once the layout settles NO two boxes overlap.
 *
 * There is no momentum and no extra spreading force: in open space a pill sits exactly on
 * its point, and only where two would collide do they push each other just far enough to
 * stop overlapping. There are no connector lines. Each pill's net movement this frame is
 * recorded back into (vx, vy) so the caller's loop can read vx^2+vy^2 to tell when the
 * layout has come to rest and park itself.
 */
export function stepSimulation(nodes: SimNode[], cfg: SimConfig): void {
	const { spring, separation, padding, maxLeader } = cfg;

	// Remember each offset so the net movement this frame can be reported as (vx, vy).
	const prevOx = nodes.map((n) => n.ox);
	const prevOy = nodes.map((n) => n.oy);

	// 1. Spring: ease each pill's offset a fraction of the way back toward zero (its
	//    origin / venue coordinate). An unobstructed pill converges onto its point.
	for (const n of nodes) {
		n.ox *= 1 - spring;
		n.oy *= 1 - spring;
	}

	// 2. Collision resolution: a few position-based passes that move any pair whose padded
	//    boxes overlap directly apart (half the correction each) along their least-
	//    penetration axis. `separation` is the fraction of the penetration each pass
	//    removes; a handful of passes converges so that, at rest, no two boxes overlap.
	//    Absolute screen positions (anchor + offset) drive the test, so a venue's real
	//    on-screen spot is what collides.
	for (let pass = 0; pass < COLLISION_PASSES; pass++) {
		for (let i = 0; i < nodes.length; i++) {
			const a = nodes[i];
			const ax = a.ax + a.ox;
			const ay = a.ay + a.oy;
			for (let j = i + 1; j < nodes.length; j++) {
				const b = nodes[j];
				const dx = b.ax + b.ox - ax;
				const dy = b.ay + b.oy - ay;
				// Overlap of the padded boxes on each axis; both > 0 means they intersect.
				const overlapX = a.hw + b.hw + padding - Math.abs(dx);
				const overlapY = a.hh + b.hh + padding - Math.abs(dy);
				if (overlapX <= 0 || overlapY <= 0) continue;
				if (overlapX <= overlapY) {
					// Cheaper to separate on x. A deterministic sign breaks the tie when the
					// centres share an x, so the pair parts the same way every frame.
					const sign = dx !== 0 ? Math.sign(dx) : hashId(a.id + ' ' + b.id) < 0.5 ? -1 : 1;
					const shift = (separation * overlapX) / 2;
					a.ox -= shift * sign;
					b.ox += shift * sign;
				} else {
					const sign = dy !== 0 ? Math.sign(dy) : hashId(a.id + ' ' + b.id) < 0.5 ? -1 : 1;
					const shift = (separation * overlapY) / 2;
					a.oy -= shift * sign;
					b.oy += shift * sign;
				}
			}
		}
	}

	// 3. Hard-clamp each offset to `maxLeader`, then record the net movement this frame in
	//    (vx, vy) — small movement everywhere means the layout has settled.
	for (let k = 0; k < nodes.length; k++) {
		const n = nodes[k];
		const dist = Math.hypot(n.ox, n.oy);
		if (dist > maxLeader) {
			const s = maxLeader / dist;
			n.ox *= s;
			n.oy *= s;
		}
		n.vx = n.ox - prevOx[k];
		n.vy = n.oy - prevOy[k];
	}
}

/**
 * A label candidate, with the geographic origin its pill anchors to. `priority`
 * ranks labels that compete for the same screen cell (higher wins; the map passes
 * the venue's like-derived score). It should be integer-valued: the engine adds a
 * stable [0,1) id hash as a fractional tiebreak, which a fractional priority could
 * otherwise interleave with. Omitted means 0 — tie-break only.
 */
export type Candidate = {
	id: string;
	name: string;
	lat: number;
	lng: number;
	priority?: number;
};

/** Projects a lng/lat to CSS-pixel screen coordinates (i.e. `map.project`). */
export type Projector = (lng: number, lat: number) => { x: number; y: number };

/** One rendered pill, returned to the component to drive its keyed `{#each}`. */
export type RenderItem = { id: string; name: string; selected: boolean };

/** A simulation node plus the data and DOM element it renders to. */
export type LabelNode = SimNode & {
	name: string;
	lat: number;
	lng: number;
	el: HTMLElement | null;
};

export type RecomputeOptions = {
	candidates: Candidate[];
	project: Projector;
	// The overlay's CSS size, and the off-screen margin within which anchors still
	// count (so a pill entering from the edge is simulated before it scrolls in).
	width: number;
	height: number;
	margin: number;
	selectedId: string | null;
	// Geographic declutter grid: cell size in DEGREES (size it from the live zoom via
	// geoCellDegrees so on-screen density stays ≈ a target px), how many labels survive per
	// cell (the density cap — see selectVisible), and a hard cap on simultaneous pills.
	// Degrees, not pixels, so the lattice is absolute and pan-invariant on the globe too.
	cellDeg: number;
	perCell: number;
	max: number;
};

/**
 * Owns the persistent pill state across frames. `recompute` (throttled) re-picks
 * the visible set; `tick` (per frame) re-projects and advances it. Plain `Map`/
 * `Set` live here in the module rather than the component, where they'd be
 * (wrongly) flagged as non-reactive — these are deliberately imperative, mutated
 * 60×/s, and must not trigger reactivity.
 */
export class LabelEngine {
	private nodes = new Map<string, LabelNode>();
	private visibleIds: string[] = [];
	// Ids currently shown via the free-space fill (grid losers admitted into free
	// screen room). Persisted across recomputes — membership feeds the fill's
	// hysteresis, so an admitted pill isn't re-judged against the strict admission
	// clearance every pass as the camera slides.
	private admitted = new Set<string>();

	/**
	 * Re-pick the visible labels for the current camera: project every candidate,
	 * drop those off-screen, declutter the rest, sync the node map (seeding new
	 * pills on their origin, pruning departed ones), and return the render list in
	 * candidate order for a stable key sequence.
	 */
	recompute(opts: RecomputeOptions): RenderItem[] {
		const { candidates, project, width, height, margin, selectedId, cellDeg, perCell, max } = opts;

		const anchors: LabelAnchor[] = [];
		const boxes = new Map<string, FillBox>();
		const candidateIds = new Set<string>();
		for (const c of candidates) {
			candidateIds.add(c.id);
			// Project only to cull what's off screen — the visible window still has to be
			// decided in screen space. The cull uses the live (globe-correct) per-point
			// projection; only the DECLUTTER cell is moved out of screen space, below.
			const p = project(c.lng, c.lat);
			if (p.x < -margin || p.y < -margin || p.x > width + margin || p.y > height + margin) {
				continue;
			}
			// Caller priority (an integer rank — the venue score) plus the stable
			// [0,1) id hash as a fractional tiebreak, so equal-priority candidates
			// still order deterministically from the DATA alone — never from input
			// order, which varies with fetch/merge order and would flip a cell's
			// winner between pans. Selection trumps everything.
			const priority = c.id === selectedId ? Infinity : (c.priority ?? 0) + hashId(c.id);
			anchors.push({
				id: c.id,
				// Bucket on the absolute geographic lattice: the venue's coordinate, shifted
				// non-negative before the floor so it floors consistently across the equator/
				// prime-meridian (matching the shared grid in $lib/grid). A pan doesn't move
				// the coordinate, so the cell is pan-invariant on the globe as well as Mercator.
				cellX: Math.floor((c.lng + 180) / cellDeg),
				cellY: Math.floor((c.lat + 90) / cellDeg),
				priority
			});
			// The candidate's box for the free-space fill: the measured pill where one
			// has rendered before (nodes persist while the venue stays a candidate),
			// the generous estimate for a pill that has never mounted.
			const node = this.nodes.get(c.id);
			const measured = node !== undefined && node.hw > 1;
			boxes.set(c.id, {
				id: c.id,
				x: p.x,
				y: p.y,
				hw: measured ? node.hw : FILL_EST_HALF_W_PX,
				hh: measured ? node.hh : FILL_EST_HALF_H_PX,
				priority
			});
		}

		const keep = selectVisible(anchors, perCell, max);
		// Second pass: grid losers whose overlap the force sim can resolve are shown
		// anyway (see fillFreeSpace) — the grid bounds density, the fill stops it
		// hiding a venue the layout actually has room for (nudged pills included).
		// The count budget keeps the global ceiling: kept + admitted ≤ max.
		const keptBoxes: FillBox[] = [];
		const restBoxes: FillBox[] = [];
		for (const a of anchors) {
			const box = boxes.get(a.id);
			if (box === undefined) continue;
			(keep.has(a.id) ? keptBoxes : restBoxes).push(box);
		}
		this.admitted = fillFreeSpace(keptBoxes, restBoxes, this.admitted, max - keep.size);

		const items: RenderItem[] = [];
		const visible: string[] = [];
		for (const c of candidates) {
			if (!keep.has(c.id) && !this.admitted.has(c.id)) continue;
			let node = this.nodes.get(c.id);
			if (node) {
				node.name = c.name;
				node.lat = c.lat;
				node.lng = c.lng;
			} else {
				const p = project(c.lng, c.lat);
				// Seed the offset at zero, so a new pill starts centred exactly on its
				// venue's coordinate. The spring holds it there; the collision push is what
				// nudges it off only when a neighbour would otherwise overlap it.
				node = {
					id: c.id,
					name: c.name,
					lat: c.lat,
					lng: c.lng,
					ax: p.x,
					ay: p.y,
					ox: 0,
					oy: 0,
					vx: 0,
					vy: 0,
					hw: 0,
					hh: 0,
					el: null
				};
				this.nodes.set(c.id, node);
			}
			items.push({ id: c.id, name: c.name, selected: c.id === selectedId });
			visible.push(c.id);
		}

		// Drop nodes whose venue is no longer a candidate (left the viewport and
		// isn't selected); kept-but-hidden ones survive so their position persists.
		for (const id of this.nodes.keys()) {
			if (!candidateIds.has(id)) this.nodes.delete(id);
		}

		this.visibleIds = visible;
		return items;
	}

	/** Bind a pill's DOM element and its measured half-extents. */
	attach(id: string, el: HTMLElement, hw: number, hh: number): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.el = el;
		node.hw = hw;
		node.hh = hh;
	}

	/** Unbind a pill's DOM element on unmount (guarded against a stale element). */
	detach(id: string, el: HTMLElement): void {
		const node = this.nodes.get(id);
		if (node && node.el === el) node.el = null;
	}

	/** The current node for an id, if any (used to place a pill the moment it mounts). */
	get(id: string): LabelNode | null {
		return this.nodes.get(id) ?? null;
	}

	/**
	 * The id of the topmost visible pill whose box contains the given screen point
	 * (CSS px, the map's `project` space), or null. Pills are pointer-transparent so
	 * map gestures pass through them, so click-to-select and the hover cursor are
	 * resolved against their boxes here instead of via DOM events. `slop` inflates
	 * the box by a few px so a small pill stays a comfortable tap target. Later pills
	 * in paint order win, matching what the user sees on top.
	 */
	hitTest(x: number, y: number, slop = 0): string | null {
		let hit: string | null = null;
		for (const id of this.visibleIds) {
			const n = this.nodes.get(id);
			if (!n) continue;
			if (
				Math.abs(x - (n.ax + n.ox)) <= n.hw + slop &&
				Math.abs(y - (n.ay + n.oy)) <= n.hh + slop
			) {
				hit = id;
			}
		}
		return hit;
	}

	/**
	 * Advance one frame: refresh every visible node's anchor from the live
	 * projection, step the force model, and return the active nodes so the caller
	 * can write each pill's transform.
	 */
	tick(project: Projector, config: SimConfig): LabelNode[] {
		const active: LabelNode[] = [];
		for (const id of this.visibleIds) {
			const node = this.nodes.get(id);
			if (!node) continue;
			const p = project(node.lng, node.lat);
			node.ax = p.x;
			node.ay = p.y;
			active.push(node);
		}
		stepSimulation(active, config);
		return active;
	}

	/** Forget every pill (on unmount). */
	clear(): void {
		this.nodes.clear();
		this.visibleIds = [];
	}
}
