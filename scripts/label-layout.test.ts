import { expect, test, describe } from 'bun:test';
import {
	hashId,
	holdZoom,
	geoCellDegrees,
	selectVisible,
	stepSimulation,
	LabelEngine,
	type LabelAnchor,
	type SimNode,
	type SimConfig,
	type Candidate
} from '../src/lib/label-layout';

// Mirrors the component's SIM_CONFIG: a strong spring that holds each pill on its venue
// coordinate, plus a position-based collision pass that separates only overlapping boxes.
const CFG: SimConfig = {
	spring: 0.25,
	separation: 0.5,
	padding: 6,
	maxLeader: 120
};

const absX = (n: SimNode) => n.ax + n.ox;
const absY = (n: SimNode) => n.ay + n.oy;
const overlaps = (a: SimNode, b: SimNode) =>
	Math.abs(absX(a) - absX(b)) < a.hw + b.hw && Math.abs(absY(a) - absY(b)) < a.hh + b.hh;

// The deepest box overlap (px, no padding) across all pairs — 0 when nothing overlaps.
const maxBoxOverlap = (nodes: SimNode[]): number => {
	let m = 0;
	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			const ox = nodes[i].hw + nodes[j].hw - Math.abs(absX(nodes[i]) - absX(nodes[j]));
			const oy = nodes[i].hh + nodes[j].hh - Math.abs(absY(nodes[i]) - absY(nodes[j]));
			if (ox > 0 && oy > 0) m = Math.max(m, Math.min(ox, oy));
		}
	}
	return m;
};

// The component's settle threshold: the rAF loop parks once every pill's per-frame
// movement (vx²+vy², the offset change the sim records) has stayed below this for a
// stretch of frames.
const SETTLE_KE_EPS = 0.0016;
// Mirrors the component's SIM_MAX_SETTLE_FRAMES: once the camera is still, the loop gives
// the sim this many frames to settle, then parks regardless. A normal cluster must reach
// rest WITHIN this budget, or labels would ship permanently jostling — asserted below.
const SIM_MAX_SETTLE_FRAMES = 240;

// Steps the simulation and returns the frame on which it SETTLED — the first frame of
// the run where max per-frame movement fell below SETTLE_KE_EPS and stayed there for 60
// consecutive frames (mirroring the rAF loop's park condition) — or -1 if it never did.
const settleStep = (nodes: SimNode[], cfg: SimConfig, maxSteps = 1500): number => {
	let belowRun = 0;
	let settled = -1;
	for (let step = 0; step < maxSteps; step++) {
		stepSimulation(nodes, cfg);
		let maxKE = 0;
		for (const n of nodes) {
			const ke = n.vx * n.vx + n.vy * n.vy;
			if (ke > maxKE) maxKE = ke;
		}
		if (maxKE < SETTLE_KE_EPS) {
			belowRun++;
			if (belowRun >= 60 && settled < 0) settled = step - 59;
		} else {
			belowRun = 0;
			settled = -1; // a fresh excursion above the bar resets the settled mark
		}
	}
	return settled;
};

describe('hashId', () => {
	test('is deterministic and in [0, 1)', () => {
		const h = hashId('abc');
		expect(h).toBe(hashId('abc'));
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThan(1);
	});

	test('differs across ids', () => {
		expect(hashId('alpha')).not.toBe(hashId('bravo'));
	});
});

describe('holdZoom', () => {
	test('ignores jitter (and small moves) below the threshold', () => {
		expect(holdZoom(11, 11.0004, 0.25)).toBe(11);
		expect(holdZoom(11, 10.9996, 0.25)).toBe(11);
		expect(holdZoom(11, 11.2, 0.25)).toBe(11); // within threshold, still held
	});

	test('adopts a deliberate zoom at or beyond the threshold', () => {
		expect(holdZoom(11, 11.25, 0.25)).toBe(11.25);
		expect(holdZoom(11, 10.7, 0.25)).toBe(10.7);
	});

	test('adopts immediately from a seed value (large first delta)', () => {
		expect(holdZoom(0, 11, 0.25)).toBe(11);
	});

	test('holds steady through the exact jitter wander seen in the wild', () => {
		// The zoom samples captured while panning over Vancouver — a ±0.0004 wander that, fed
		// straight to the cell size, flickered labels. Held, the cell zoom never budges, and
		// — the property that actually matters — the declutter CELL SIZE it feeds is constant,
		// whereas the raw jittered zoom would have wobbled it (which is what flipped labels).
		const wander = [10.9306, 10.9308, 10.9309, 10.9304, 10.9299, 10.9296, 10.9295, 10.9297];
		let z = holdZoom(0, 10.93, 0.25); // first frame adopts the real zoom
		const heldCells = new Set<number>();
		const rawCells = new Set<number>();
		for (const live of wander) {
			z = holdZoom(z, live, 0.25);
			heldCells.add(geoCellDegrees(z, 84));
			rawCells.add(geoCellDegrees(live, 84));
		}
		expect(z).toBe(10.93);
		expect(heldCells.size).toBe(1); // cell size never wobbles → no boundary-label flips
		expect(rawCells.size).toBeGreaterThan(1); // the raw jitter WOULD have wobbled it
	});
});

describe('selectVisible', () => {
	// Anchors carry their pre-computed absolute-lattice cell (cellX, cellY) — what
	// LabelEngine.recompute stamps from each venue's quantized lng/lat. selectVisible is
	// then pure cell bucketing: thin by priority within each cell, then a global max.
	const anchors: LabelAnchor[] = [
		{ id: 'a', cellX: 1, cellY: 1, priority: 0.9 },
		{ id: 'b', cellX: 1, cellY: 1, priority: 0.5 }, // same cell as a → loses
		{ id: 'c', cellX: 4, cellY: 4, priority: 0.1 } // own cell → kept
	];

	test('keeps the higher-priority pill when two share a cell', () => {
		const keep = selectVisible(anchors, 1, 100);
		expect(keep.has('a')).toBe(true);
		expect(keep.has('b')).toBe(false);
	});

	test('keeps a pill alone in its cell', () => {
		expect(selectVisible(anchors, 1, 100).has('c')).toBe(true);
	});

	test('honours the global max cap, keeping the highest priority', () => {
		const keep = selectVisible(anchors, 1, 1);
		expect(keep.size).toBe(1);
		expect(keep.has('a')).toBe(true); // a (0.9) outranks c (0.1)
	});

	test('perCell caps how many survive within one cell', () => {
		// Five anchors in one cell; perCell 2 keeps the top two by priority.
		const packed: LabelAnchor[] = Array.from({ length: 5 }, (_, i) => ({
			id: `p${i}`,
			cellX: 0,
			cellY: 0,
			priority: i / 10
		}));
		const keep = selectVisible(packed, 2, 100);
		expect(keep.size).toBe(2);
		expect([...keep].toSorted()).toEqual(['p3', 'p4']); // priorities 0.4, 0.3
	});

	test('perCell Infinity keeps every co-celled anchor, bounded only by max', () => {
		// A venue's co-anchored menu: all share one cell, none should be thinned out.
		const packed: LabelAnchor[] = Array.from({ length: 6 }, (_, i) => ({
			id: `q${i}`,
			cellX: 0,
			cellY: 0,
			priority: i
		}));
		expect(selectVisible(packed, Infinity, 100).size).toBe(6);
		expect(selectVisible(packed, Infinity, 4).size).toBe(4); // global cap still bites
	});

	test('spreads density: one survivor per occupied cell', () => {
		// A 3×3 lattice of cells, two anchors in each; perCell 1 keeps exactly one per cell.
		const grid: LabelAnchor[] = [];
		for (let cx = 0; cx < 3; cx++) {
			for (let cy = 0; cy < 3; cy++) {
				grid.push({ id: `${cx}-${cy}-hi`, cellX: cx, cellY: cy, priority: 1 });
				grid.push({ id: `${cx}-${cy}-lo`, cellX: cx, cellY: cy, priority: 0 });
			}
		}
		const keep = selectVisible(grid, 1, 100);
		expect(keep.size).toBe(9); // one per occupied cell
		expect([...keep].every((id) => id.endsWith('-hi'))).toBe(true); // the higher-priority one
	});

	test('keeps a high-priority group intact while trimming a co-celled neighbour', () => {
		// The item-label case: a selected venue's whole 10-item cluster (highest priority)
		// shares a cell with a neighbour venue's 4 items. A perCell of 12 keeps the cluster
		// intact — a venue's labels are contiguous in priority — and trims the rest.
		const labels: LabelAnchor[] = [];
		for (let i = 0; i < 10; i++)
			labels.push({ id: `sel-${i}`, cellX: 2, cellY: 2, priority: 100 - i });
		for (let i = 0; i < 4; i++)
			labels.push({ id: `nb-${i}`, cellX: 2, cellY: 2, priority: 50 - i });
		const keep = selectVisible(labels, 12, 80);
		expect(keep.size).toBe(12);
		for (let i = 0; i < 10; i++) expect(keep.has(`sel-${i}`)).toBe(true); // cluster intact
		expect(keep.has('nb-0')).toBe(true); // plus the neighbour's top two
		expect(keep.has('nb-1')).toBe(true);
		expect(keep.has('nb-2')).toBe(false); // and not the rest
		expect(keep.has('nb-3')).toBe(false);
	});

	test('does not mutate the input array', () => {
		const copy = [...anchors];
		selectVisible(anchors, 1, 100);
		expect(anchors).toEqual(copy);
	});
});

describe('stepSimulation', () => {
	const mk = (id: string, ox: number, ax = 200): SimNode => ({
		id,
		ax,
		ay: 200,
		ox,
		oy: 0,
		vx: 0,
		vy: 0,
		hw: 40,
		hh: 11
	});

	test('two overlapping pills separate and end clear of each other, within maxLeader', () => {
		// Both spring to the SAME point, so the only way to stop overlapping is to push apart.
		const nodes = [mk('a', -1), mk('b', 1)];
		for (let i = 0; i < 600; i++) stepSimulation(nodes, CFG);
		expect(overlaps(nodes[0], nodes[1])).toBe(false);
		for (const n of nodes) {
			expect(Math.hypot(n.ox, n.oy)).toBeLessThanOrEqual(CFG.maxLeader + 0.5);
		}
	});

	test('a lone pill settles onto its origin', () => {
		const n: SimNode = {
			id: 'solo',
			ax: 50,
			ay: 60,
			ox: 250,
			oy: -51,
			vx: 0,
			vy: 0,
			hw: 30,
			hh: 11
		};
		for (let i = 0; i < 800; i++) stepSimulation([n], CFG);
		expect(Math.hypot(n.ox, n.oy)).toBeLessThan(0.5);
	});

	test('a pill with no neighbour homes onto its origin and is never pushed off it', () => {
		// Two pills far apart: each is pulled onto its own coordinate; nothing pushes it off.
		const nodes = [mk('a', 6, 100), mk('b', -6, 600)];
		for (let i = 0; i < 300; i++) stepSimulation(nodes, CFG);
		for (const n of nodes) expect(Math.hypot(n.ox, n.oy)).toBeLessThan(0.5);
	});

	test('a rigid pan of every anchor leaves the layout unchanged (no pan lag)', () => {
		const nodes = [mk('a', -1, 500), mk('b', 1, 500)];
		for (let i = 0; i < 600; i++) stepSimulation(nodes, CFG); // settle
		const before = nodes.map((n) => ({ ox: n.ox, oy: n.oy }));
		for (let i = 0; i < 10; i++) {
			for (const n of nodes) {
				n.ax += 120;
				n.ay += 40;
			}
			stepSimulation(nodes, CFG);
		}
		for (let i = 0; i < nodes.length; i++) {
			expect(Math.hypot(nodes[i].ox - before[i].ox, nodes[i].oy - before[i].oy)).toBeLessThan(0.5);
		}
	});

	test('a cluster of overlapping neighbours settles overlap-free near their points', () => {
		// Four venues whose boxes overlap their neighbours but for which a clear arrangement
		// exists comfortably within the leader cap: a 2×2 block where each pill need only
		// nudge a little to part from the one beside it. The collision must reach a rest
		// state the loop can park on, with no two boxes overlapping and every pill still
		// close to its own coordinate.
		const nodes: SimNode[] = [
			{ id: 'tl', ax: 300, ay: 220, ox: 0, oy: 0, vx: 0, vy: 0, hw: 35, hh: 12 },
			{ id: 'tr', ax: 350, ay: 220, ox: 0, oy: 0, vx: 0, vy: 0, hw: 35, hh: 12 },
			{ id: 'bl', ax: 300, ay: 252, ox: 0, oy: 0, vx: 0, vy: 0, hw: 35, hh: 12 },
			{ id: 'br', ax: 350, ay: 252, ox: 0, oy: 0, vx: 0, vy: 0, hw: 35, hh: 12 }
		];
		const settled = settleStep(nodes, CFG);
		expect(settled).toBeGreaterThanOrEqual(0);
		// ...and reaches rest WITHIN the budget the live loop allows before it parks, so a
		// normal cluster never ships still-jostling (a future SIM_CONFIG retune that broke
		// this would fail here rather than silently shipping perpetual motion).
		expect(settled).toBeLessThan(SIM_MAX_SETTLE_FRAMES);
		expect(maxBoxOverlap(nodes)).toBeLessThan(2);
		// Each pill ends near its own coordinate (only a modest nudge was needed to part).
		for (const n of nodes) expect(Math.hypot(n.ox, n.oy)).toBeLessThan(40);
	});
});

describe('LabelEngine', () => {
	// A fake projector: screen = anchor at (originX + lng*10, lat*10). `originX` mimics a
	// horizontal pan; it now only moves where pills are CULLED (off-screen), since the
	// declutter cell is bucketed from lng/lat, not the projected pixel.
	const makeOpts = (candidates: Candidate[], selectedId: string | null, originX: number) => ({
		candidates,
		project: (lng: number, lat: number) => ({ x: originX + lng * 10, y: lat * 10 }),
		width: 1000,
		height: 1000,
		margin: 80,
		selectedId,
		cellDeg: 42,
		perCell: 1,
		max: 100
	});

	const cands: Candidate[] = [
		{ id: 'a', name: 'Alpha', lat: 5, lng: 5 },
		{ id: 'b', name: 'Bravo', lat: 50, lng: 50 },
		{ id: 'sel', name: 'Selected', lat: 5.1, lng: 5.1 } // crowds 'a'
	];

	test('keeps the selected pill and drops its lower-priority crowded neighbour', () => {
		const engine = new LabelEngine();
		const items = engine.recompute(makeOpts(cands, 'sel', 0));
		expect(items.find((i) => i.id === 'sel')?.selected).toBe(true);
		expect(items.some((i) => i.id === 'a')).toBe(false);
		expect(items.some((i) => i.id === 'b')).toBe(true);
	});

	test('caller priority (the venue score) outranks the hash tie-break in a shared cell', () => {
		// Give the WORSE-hashed candidate the higher priority, so a win can only
		// come from the priority — never from the hash the old fallback used.
		const [loHash, hiHash] = hashId('a') < hashId('b') ? ['a', 'b'] : ['b', 'a'];
		const crowd: Candidate[] = [
			{ id: loHash, name: 'Low hash, liked', lat: 5, lng: 5, priority: 3 },
			{ id: hiHash, name: 'High hash, unliked', lat: 5.1, lng: 5.1, priority: 0 }
		];
		const items = new LabelEngine().recompute(makeOpts(crowd, null, 0));
		expect(items.map((i) => i.id)).toEqual([loHash]);
	});

	test('equal priorities tie-break by the stable id hash, not input order', () => {
		const crowd: Candidate[] = [
			{ id: 'a', name: 'Alpha', lat: 5, lng: 5, priority: 2 },
			{ id: 'b', name: 'Bravo', lat: 5.1, lng: 5.1, priority: 2 }
		];
		const expected = hashId('a') > hashId('b') ? 'a' : 'b';
		const forward = new LabelEngine().recompute(makeOpts(crowd, null, 0));
		const reversed = new LabelEngine().recompute(makeOpts([...crowd].reverse(), null, 0));
		expect(forward.map((i) => i.id)).toEqual([expected]);
		expect(reversed.map((i) => i.id)).toEqual([expected]);
	});

	test('tick re-projects anchors against the live camera', () => {
		const engine = new LabelEngine();
		engine.recompute(makeOpts(cands, 'sel', 0));
		const first = engine
			.tick((lng, lat) => ({ x: lng * 10, y: lat * 10 }), CFG)
			.find((n) => n.id === 'b');
		if (!first) throw new Error("node 'b' should be live");
		// Read the value now — `tick` mutates this same node object in place, so the
		// second pan would otherwise overwrite what we're comparing against.
		const before = first.ax;
		const second = engine
			.tick((lng, lat) => ({ x: 200 + lng * 10, y: lat * 10 }), CFG)
			.find((n) => n.id === 'b');
		if (!second) throw new Error("node 'b' should be live");
		expect(second.ax - before).toBeCloseTo(200, 5);
	});

	test('the kept set is pan-invariant under a NON-LINEAR (globe) projection', () => {
		// The map renders on a globe when zoomed out, where a pan is a sphere ROTATION:
		// points at different lng/lat shift on screen by different amounts, so a screen-space
		// declutter lattice reshuffles mid-pan (the zoomed-out flicker). Bucketing on the
		// absolute lat/lng lattice is immune — a venue's coordinate doesn't move when the
		// camera pans. This models a globe pan with a deliberately non-affine projector and
		// asserts the kept set never changes. `hi` and `lo` are 1° apart (so a screen lattice
		// WOULD sometimes split them, sometimes merge them, as `rot` varies) but share one
		// geographic cell, so exactly one survives at every rotation.
		const crowd: Candidate[] = [
			{ id: 'hi', name: 'Hi', lat: 0, lng: 10, priority: 1 },
			{ id: 'lo', name: 'Lo', lat: 0, lng: 11, priority: 0 } // shares hi's geo cell
		];
		// Non-affine: screen x bends sinusoidally with longitude (a crude globe) and `rot`
		// (the pan) enters inside the sine, so different lngs move by different screen amounts.
		const globe = (rot: number) => (lng: number, lat: number) => ({
			x: 500 + 400 * Math.sin(((lng - rot) * Math.PI) / 180),
			y: 500 - 400 * Math.sin((lat * Math.PI) / 180)
		});
		const keptAt = (rot: number) =>
			new LabelEngine()
				.recompute({
					candidates: crowd,
					project: globe(rot),
					width: 1000,
					height: 1000,
					margin: 200,
					selectedId: null,
					cellDeg: 2, // ~2° cells: hi & lo (1° apart) share one; far apart in screen px
					perCell: 1,
					max: 100
				})
				.map((i) => i.id)
				.toSorted();

		const baseline = keptAt(0);
		expect(baseline).toEqual(['hi']); // one geo cell → only the higher-priority one
		for (const rot of [5, 20, 95, -80, 150]) {
			expect(keptAt(rot)).toEqual(baseline); // a screen lattice would have flickered here
		}
	});

	test('prunes a candidate that has left the set', () => {
		const engine = new LabelEngine();
		engine.recompute(makeOpts(cands, 'sel', 0));
		const items = engine.recompute(
			makeOpts(
				cands.filter((c) => c.id !== 'b'),
				'sel',
				0
			)
		);
		expect(items.some((i) => i.id === 'b')).toBe(false);
	});

	test('co-located labels are separated by the collision so none overlap', () => {
		// Four labels sharing ONE anchor: they all seed at offset (0, 0), exactly coincident.
		// The collision must still push them apart (deterministically, via the id-hashed tie
		// break) so that, once settled, no two overlap and each stays within the leader cap.
		const engine = new LabelEngine();
		const co: Candidate[] = Array.from({ length: 4 }, (_, i) => ({
			id: `item-${i}`,
			name: `Item ${i}`,
			lat: 10,
			lng: 10
		}));
		const project = (lng: number, lat: number) => ({ x: lng * 10, y: lat * 10 });
		// perCell Infinity disables per-cell thinning, so all four co-located candidates
		// survive declutter and the collision alone is what's under test here.
		engine.recompute({
			candidates: co,
			project,
			width: 1000,
			height: 1000,
			margin: 80,
			selectedId: null,
			cellDeg: 1,
			perCell: Infinity,
			max: 100
		});
		// Give every pill a measured box so the collision has something to separate.
		for (const c of co) engine.attach(c.id, null as unknown as HTMLElement, 30, 11);
		let nodes: SimNode[] = [];
		for (let i = 0; i < 800; i++) nodes = engine.tick(project, CFG);
		expect(nodes.length).toBe(co.length);
		// Starting coincident, the collision pushed each pill off the shared point...
		for (const n of nodes) {
			expect(Math.hypot(n.ox, n.oy)).toBeGreaterThan(0.5);
		}
		// ...no two boxes overlap...
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				expect(overlaps(nodes[i], nodes[j])).toBe(false);
			}
		}
		// ...and each stays within the leader clamp.
		for (const n of nodes) {
			expect(Math.hypot(n.ox, n.oy)).toBeLessThanOrEqual(CFG.maxLeader + 0.5);
		}
	});

	test('hitTest returns the pill under a point, with slop, else null', () => {
		const engine = new LabelEngine();
		const project = (lng: number, lat: number) => ({ x: lng, y: lat });
		engine.recompute({
			candidates: [{ id: 'p', name: 'Pizza', lat: 300, lng: 200 }],
			project,
			width: 1000,
			height: 1000,
			margin: 80,
			selectedId: null,
			cellDeg: 84,
			perCell: 1,
			max: 100
		});
		engine.attach('p', null as unknown as HTMLElement, 30, 11); // measured half-extents
		// A new node seeds at offset zero (see recompute), so the lone pill already sits
		// exactly on its anchor; a few ticks confirm the spring keeps it there.
		for (let i = 0; i < 400; i++) engine.tick(project, CFG);
		expect(engine.hitTest(210, 305)).toBe('p'); // inside the box
		expect(engine.hitTest(235, 305)).toBeNull(); // outside (box half-width 30 → edge at 230)
		expect(engine.hitTest(235, 305, 6)).toBe('p'); // slop reaches it
		expect(engine.hitTest(700, 700)).toBeNull(); // far away
	});
});
