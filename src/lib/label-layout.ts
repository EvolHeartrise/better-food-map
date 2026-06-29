// Screen-space layout for the map's venue-name labels.
//
// The map draws every venue as a black-on-white name pill "magnetized" to its
// projected origin — there are no marker dots. The geometry lives here, framework
// -free, so it can be unit-tested and kept out of the Svelte component, which is
// left as thin glue around `LabelEngine`:
//
//   • `selectVisible` decides WHICH pills to show at the current zoom. It greedily
//     keeps the highest-priority labels whose anchors aren't packed tighter than
//     `minGap` px and hides the rest. Because the projected anchors spread apart on
//     screen as the user zooms in, more labels clear the bar at higher zoom — that
//     is how names reveal progressively without ever drawing a dot.
//
//   • `stepSimulation` advances the force model one frame: every pill is pulled
//     toward its origin (a spring) and pushed off any overlapping neighbour, so a knot
//     of nearby venues — or a venue's whole menu all springing to one point — fans out
//     into a compact cluster centred on the point, while each pill stays tethered to it
//     by a short leader line.
//
//   • `LabelEngine` owns the persistent per-pill state across frames and ties the
//     two together: `recompute` re-picks the visible set, `tick` re-projects and
//     advances it, and `attach`/`detach` bind the rendered DOM elements.

/** A candidate label's projected origin and tie-break priority, for decluttering. */
export type LabelAnchor = {
	id: string;
	// The projected origin in CSS pixels, relative to the map container.
	ax: number;
	ay: number;
	// Higher wins when two anchors are too close for both to survive (the selected
	// venue uses Infinity so it is never decluttered away).
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
	// Pill-centre offset from the anchor, and the velocity of that offset.
	ox: number;
	oy: number;
	vx: number;
	vy: number;
	// Half the measured pill width/height, used as the pill's collision extent.
	hw: number;
	hh: number;
	// Multiplies this pill's spring constant (default 1). Name pills set this > 1 so
	// they hold near their own dot while the lighter item pills fan out around them.
	springScale?: number;
};

export type SimConfig = {
	// Pull toward the anchor per tick, as a fraction of the remaining offset.
	spring: number;
	// Fraction of velocity retained per tick (0–1); lower settles faster.
	damping: number;
	// Stiffness of the radial separation force: the push two overlapping pills get,
	// per px of penetration, along their centre-to-centre line. (Force = −∇U of the
	// penalty energy U = ½·separation·penetration², so the model stays conservative.)
	separation: number;
	// Extra breathing room kept between pills, in px.
	padding: number;
	// How far a pill may drift from its origin before the leader is clamped, in px.
	maxLeader: number;
	// Shapes each pill's effective collision radius: `hh + radiusBlend·(hw − hh)`.
	// 1 ⇒ the half-width (an isotropic circle that circumscribes the wide-short pill,
	// so a co-anchored cluster relaxes into a ROUND blob); smaller ⇒ tighter/flatter.
	radiusBlend: number;
};

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
 * Greedy decluttering: keep the highest-priority anchors that sit at least
 * `minGap` px from every already-kept anchor, up to `max` of them. Returns the set
 * of kept ids. Input order doesn't matter — selection is by descending priority.
 */
export function selectVisible(anchors: LabelAnchor[], minGap: number, max: number): Set<string> {
	const sorted = anchors.toSorted((a, b) => b.priority - a.priority);
	const kept: LabelAnchor[] = [];
	const keptIds = new Set<string>();
	const gapSq = minGap * minGap;
	for (const a of sorted) {
		if (kept.length >= max) break;
		let ok = true;
		for (const k of kept) {
			const dx = a.ax - k.ax;
			const dy = a.ay - k.ay;
			if (dx * dx + dy * dy < gapSq) {
				ok = false;
				break;
			}
		}
		if (ok) {
			kept.push(a);
			keptIds.add(a.id);
		}
	}
	return keptIds;
}

/**
 * Fraction of `maxLeader` at which a soft inward "cushion" begins. Within
 * [LEADER_CUSHION·maxLeader, maxLeader] a pill feels an extra, smooth restoring pull
 * back toward its origin (on top of the spring), growing with how far it has strayed.
 * This is a conservative force — the gradient of a quadratic boundary potential — so it
 * doesn't break the energy-descent guarantee; its job is to DECELERATE pills before
 * they pile onto the hard `maxLeader` ring. A crowd of pills pinned hard on that ring
 * can shuffle tangentially forever (a limit cycle that never settles); the cushion lets
 * them relax inward instead, so even an over-full cluster still converges.
 */
const LEADER_CUSHION = 0.7;
/** Stiffness of the leader cushion: extra inward force per px past the cushion radius. */
const LEADER_CUSHION_STRENGTH = 0.5;

/**
 * Advance the pill positions one frame, mutating the nodes in place. Everything
 * operates on the anchor-relative offset (`ox`, `oy`): the spring pulls it toward
 * zero and collisions push it outward, so the rigid component of any camera motion
 * (a pan re-projecting every anchor by the same delta) never enters the dynamics.
 *
 * The whole step is DAMPED GRADIENT DESCENT on one smooth energy — inward springs +
 * pairwise repulsion + the leader cushion are each the negative gradient of a potential,
 * and the velocity damping dissipates kinetic energy — so it provably relaxes to a local
 * minimum and SETTLES (the caller's loop can then park), rather than orbiting in a limit
 * cycle the way a non-conservative push would.
 *
 * Repulsion uses a "soft circle" model: each pill is a circle of radius
 * `hh + radiusBlend·(hw − hh)` and an overlapping pair is pushed apart ALONG THEIR
 * CENTRE LINE with a force proportional to penetration depth (= −∇ of ½·separation·
 * penetration²). Because the push is radial and isotropic, a knot of co-anchored labels
 * — a venue's whole menu springing to one point — opens out into a ROUND cluster in
 * every direction, not the vertical pile the old minimum-translation (axis-aligned) push
 * produced for wide-short pills. Name pills carry a larger `springScale`, so they hold
 * near their dot while the item pills ring around them.
 */
export function stepSimulation(nodes: SimNode[], cfg: SimConfig): void {
	const { spring, damping, separation, padding, maxLeader, radiusBlend } = cfg;
	const cushionRadius = maxLeader * LEADER_CUSHION;
	const radiusOf = (n: SimNode) => n.hh + radiusBlend * (n.hw - n.hh);

	// 1. Spring each pill's offset back toward zero (its origin), scaled per-pill so a
	//    name pill (springScale > 1) resists being shoved off its dot.
	for (const n of nodes) {
		const k = spring * (n.springScale ?? 1);
		n.vx -= n.ox * k;
		n.vy -= n.oy * k;
	}

	// 2. Conservative radial repulsion. Compare absolute screen positions (anchor +
	//    offset) so a venue's real on-screen spot drives the collision, and push any
	//    overlapping pair apart along their centre-to-centre line by their penetration.
	for (let i = 0; i < nodes.length; i++) {
		const a = nodes[i];
		const ra = radiusOf(a);
		const ax = a.ax + a.ox;
		const ay = a.ay + a.oy;
		for (let j = i + 1; j < nodes.length; j++) {
			const b = nodes[j];
			let dx = b.ax + b.ox - ax;
			let dy = b.ay + b.oy - ay;
			if (dx === 0 && dy === 0) {
				// Coincident centres: pick a stable, deterministic direction so the pair
				// still separates — and separates the same way every frame.
				const angle = hashId(a.id + ' ' + b.id) * 2 * Math.PI;
				dx = Math.cos(angle) * 0.01;
				dy = Math.sin(angle) * 0.01;
			}
			const dist = Math.hypot(dx, dy);
			const minDist = ra + radiusOf(b) + padding;
			if (dist < minDist) {
				const push = separation * (minDist - dist);
				const ux = dx / dist;
				const uy = dy / dist;
				a.vx -= push * ux;
				a.vy -= push * uy;
				b.vx += push * ux;
				b.vy += push * uy;
			}
		}
	}

	// 3. Soft leader cushion: an extra inward pull once a pill strays past the cushion
	//    radius, so it decelerates before reaching the hard clamp (see LEADER_CUSHION).
	for (const n of nodes) {
		const dist = Math.hypot(n.ox, n.oy);
		if (dist > cushionRadius) {
			const f = LEADER_CUSHION_STRENGTH * (dist - cushionRadius);
			n.vx -= (f * n.ox) / dist;
			n.vy -= (f * n.oy) / dist;
		}
	}

	// 4. Integrate, damp, and hard-clamp the leader length. If a pill is still being
	//    forced past `maxLeader`, also strip the OUTWARD part of its velocity so it can't
	//    keep overshooting-and-being-pulled-back forever — that residual motion would
	//    otherwise hold the kinetic energy above the settle threshold and never park.
	for (const n of nodes) {
		n.vx *= damping;
		n.vy *= damping;
		n.ox += n.vx;
		n.oy += n.vy;
		const dist = Math.hypot(n.ox, n.oy);
		if (dist > maxLeader) {
			const k = maxLeader / dist;
			n.ox *= k;
			n.oy *= k;
			const ux = n.ox / maxLeader;
			const uy = n.oy / maxLeader;
			const vr = n.vx * ux + n.vy * uy;
			if (vr > 0) {
				n.vx -= vr * ux;
				n.vy -= vr * uy;
			}
		}
	}
}

/**
 * A label candidate, with the geographic origin its pill anchors to. Used for both
 * the venue-name pills and the menu-item labels. `priority` overrides the default
 * tie-break (a stable id hash): the item engine passes a build-order priority so a
 * crowd of co-anchored item labels keeps the nearest venues' items when capped, and
 * so the location engine can keep a chain's branches deterministically ordered.
 */
export type Candidate = {
	id: string;
	name: string;
	lat: number;
	lng: number;
	priority?: number;
	// Optional grouping key. Item labels set this to their venue id. It no longer
	// drives layout (every label springs to its own venue point in the unified force
	// pass); it's kept on the data as a stable per-venue tag.
	groupId?: string;
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
	// Grouping key (item labels carry their venue id); undefined for name pills.
	groupId?: string;
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
	// Min on-screen spacing between survivors, and a hard cap on simultaneous pills.
	gap: number;
	max: number;
	// Spring multiplier stamped on every node this engine owns (see SimNode.springScale).
	// The name-pill engine passes > 1 so its pills hold near their dots in the unified
	// force pass; the item engine leaves it at the default 1.
	springScale?: number;
};

/**
 * Radius (px) of the ring a NEW pill's offset is seeded onto, at an angle taken from
 * its id hash. Small enough that a pill still reads as starting near its origin, large
 * enough to break the symmetry of co-anchored labels (a venue's whole menu shares one
 * point) so the radial repulsion opens them out evenly from the first frame rather than
 * starting from a degenerate coincident pile. See `recompute`.
 */
const SEED_RADIUS = 10;

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

	/**
	 * Re-pick the visible labels for the current camera: project every candidate,
	 * drop those off-screen, declutter the rest, sync the node map (seeding new
	 * pills at their origin, pruning departed ones), and return the render list in
	 * candidate order for a stable key sequence.
	 */
	recompute(opts: RecomputeOptions): RenderItem[] {
		const { candidates, project, width, height, margin, selectedId, gap, max, springScale } = opts;

		const anchors: LabelAnchor[] = [];
		const candidateIds = new Set<string>();
		for (const c of candidates) {
			candidateIds.add(c.id);
			const p = project(c.lng, c.lat);
			if (p.x < -margin || p.y < -margin || p.x > width + margin || p.y > height + margin) {
				continue;
			}
			anchors.push({
				id: c.id,
				ax: p.x,
				ay: p.y,
				priority: c.id === selectedId ? Infinity : (c.priority ?? hashId(c.id))
			});
		}

		const keep = selectVisible(anchors, gap, max);

		const items: RenderItem[] = [];
		const visible: string[] = [];
		for (const c of candidates) {
			if (!keep.has(c.id)) continue;
			let node = this.nodes.get(c.id);
			if (node) {
				node.name = c.name;
				node.lat = c.lat;
				node.lng = c.lng;
				node.groupId = c.groupId;
				node.springScale = springScale;
			} else {
				const p = project(c.lng, c.lat);
				// Seed the offset on a small ring at a hashed angle rather than at the
				// origin. Co-anchored labels (a venue's whole menu) would otherwise all
				// start at exactly (0, 0); a per-id starting angle breaks that symmetry so
				// the radial repulsion opens the cluster out evenly in all directions from
				// the first frame. The spring still pulls each offset back toward zero.
				const angle = hashId(c.id) * 2 * Math.PI;
				node = {
					id: c.id,
					name: c.name,
					lat: c.lat,
					lng: c.lng,
					groupId: c.groupId,
					ax: p.x,
					ay: p.y,
					ox: Math.cos(angle) * SEED_RADIUS,
					oy: Math.sin(angle) * SEED_RADIUS,
					vx: 0,
					vy: 0,
					hw: 0,
					hh: 0,
					springScale,
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
	 * can write their transforms and draw the leader lines.
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

	/**
	 * Like `tick`, but WITHOUT stepping the force model: refresh every visible node's
	 * anchor from the live projection and return the active nodes, leaving the stepping
	 * to the caller. The component uses this to re-project BOTH engines' nodes and then
	 * run a single `stepSimulation` over their union, so the name pills and the item
	 * labels collide and spring in one unified pass.
	 */
	tickStatic(project: Projector): LabelNode[] {
		const active: LabelNode[] = [];
		for (const id of this.visibleIds) {
			const node = this.nodes.get(id);
			if (!node) continue;
			const p = project(node.lng, node.lat);
			node.ax = p.x;
			node.ay = p.y;
			active.push(node);
		}
		return active;
	}

	/** Forget every pill (e.g. when the camera drops below the overlay floor). */
	clear(): void {
		this.nodes.clear();
		this.visibleIds = [];
	}
}
