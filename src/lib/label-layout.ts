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
//     toward its origin (a spring) and pushed off any overlapping neighbour (an
//     axis-aligned separation), so a knot of nearby venues visibly fans out while
//     each pill stays tethered to its point by a short leader line.
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
	// Half the measured pill width/height, for rectangular collision.
	hw: number;
	hh: number;
};

export type SimConfig = {
	// Pull toward the anchor per tick, as a fraction of the remaining offset.
	spring: number;
	// Fraction of velocity retained per tick (0–1); lower settles faster.
	damping: number;
	// Strength of the separation push applied when two pills overlap.
	separation: number;
	// Extra breathing room kept between pills, in px.
	padding: number;
	// How far a pill may drift from its origin before the leader is clamped, in px.
	maxLeader: number;
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
 * Advance the pill positions one frame, mutating the nodes in place. Everything
 * operates on the anchor-relative offset (`ox`, `oy`): the spring pulls it toward
 * zero and collisions push it outward, so the rigid component of any camera motion
 * (a pan re-projecting every anchor by the same delta) never enters the dynamics.
 */
export function stepSimulation(nodes: SimNode[], cfg: SimConfig): void {
	const { spring, damping, separation, padding, maxLeader } = cfg;

	// Spring each pill's offset back toward zero (its origin).
	for (const n of nodes) {
		n.vx -= n.ox * spring;
		n.vy -= n.oy * spring;
	}

	// Push apart any overlapping pair along their least-overlapping axis (the
	// minimum-translation direction), comparing absolute screen positions
	// (anchor + offset) so a venue's real on-screen spot drives the collision.
	for (let i = 0; i < nodes.length; i++) {
		const a = nodes[i];
		const ax = a.ax + a.ox;
		const ay = a.ay + a.oy;
		for (let j = i + 1; j < nodes.length; j++) {
			const b = nodes[j];
			const dx = b.ax + b.ox - ax;
			const dy = b.ay + b.oy - ay;
			const overlapX = a.hw + b.hw + padding - Math.abs(dx);
			const overlapY = a.hh + b.hh + padding - Math.abs(dy);
			if (overlapX > 0 && overlapY > 0) {
				if (overlapX < overlapY) {
					const push = overlapX * 0.5 * (dx < 0 ? -1 : 1) * separation;
					a.vx -= push;
					b.vx += push;
				} else {
					const push = overlapY * 0.5 * (dy < 0 ? -1 : 1) * separation;
					a.vy -= push;
					b.vy += push;
				}
			}
		}
	}

	// Integrate, damp, and clamp how far a pill may stray from its origin.
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
		}
	}
}

/** A venue eligible to be labelled, with the origin the pill anchors to. */
export type Candidate = { id: string; name: string; lat: number; lng: number };

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
	// Min on-screen spacing between survivors, and a hard cap on simultaneous pills.
	gap: number;
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

	/**
	 * Re-pick the visible labels for the current camera: project every candidate,
	 * drop those off-screen, declutter the rest, sync the node map (seeding new
	 * pills at their origin, pruning departed ones), and return the render list in
	 * candidate order for a stable key sequence.
	 */
	recompute(opts: RecomputeOptions): RenderItem[] {
		const { candidates, project, width, height, margin, selectedId, gap, max } = opts;

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
				priority: c.id === selectedId ? Infinity : hashId(c.id)
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
			} else {
				const p = project(c.lng, c.lat);
				node = {
					id: c.id,
					name: c.name,
					lat: c.lat,
					lng: c.lng,
					ax: p.x,
					ay: p.y,
					// Seed at the origin (zero offset); it springs/spreads from there.
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

	/** Forget every pill (e.g. when the camera drops below the overlay floor). */
	clear(): void {
		this.nodes.clear();
		this.visibleIds = [];
	}
}
