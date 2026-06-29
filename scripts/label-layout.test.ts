import { expect, test, describe } from 'bun:test';
import {
	hashId,
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

describe('selectVisible', () => {
	const anchors: LabelAnchor[] = [
		{ id: 'a', ax: 100, ay: 100, priority: 0.9 },
		{ id: 'b', ax: 110, ay: 105, priority: 0.5 }, // same 84px cell as a → loses
		{ id: 'c', ax: 400, ay: 400, priority: 0.1 } // far → own cell, kept
	];

	test('keeps the higher-priority pill when two share a cell', () => {
		const keep = selectVisible(anchors, 84, 1, 100);
		expect(keep.has('a')).toBe(true);
		expect(keep.has('b')).toBe(false);
	});

	test('keeps a pill alone in its cell', () => {
		expect(selectVisible(anchors, 84, 1, 100).has('c')).toBe(true);
	});

	test('honours the global max cap, keeping the highest priority', () => {
		const keep = selectVisible(anchors, 84, 1, 1);
		expect(keep.size).toBe(1);
		expect(keep.has('a')).toBe(true); // a (0.9) outranks c (0.1)
	});

	test('perCell caps how many survive within one cell', () => {
		// Five anchors at one point; perCell 2 keeps the top two by priority.
		const packed: LabelAnchor[] = Array.from({ length: 5 }, (_, i) => ({
			id: `p${i}`,
			ax: 200,
			ay: 200,
			priority: i / 10
		}));
		const keep = selectVisible(packed, 84, 2, 100);
		expect(keep.size).toBe(2);
		expect([...keep].toSorted()).toEqual(['p3', 'p4']); // priorities 0.4, 0.3
	});

	test('perCell Infinity keeps every co-located anchor, bounded only by max', () => {
		// A venue's co-anchored menu: all share one point, none should be thinned out.
		const packed: LabelAnchor[] = Array.from({ length: 6 }, (_, i) => ({
			id: `q${i}`,
			ax: 200,
			ay: 200,
			priority: i
		}));
		expect(selectVisible(packed, 1, Infinity, 100).size).toBe(6);
		expect(selectVisible(packed, 1, Infinity, 4).size).toBe(4); // global cap still bites
	});

	test('spreads density: one survivor per occupied cell across the screen', () => {
		// A 3×3 lattice of cells, two anchors in each; perCell 1 keeps exactly one per cell.
		const grid: LabelAnchor[] = [];
		for (let cx = 0; cx < 3; cx++) {
			for (let cy = 0; cy < 3; cy++) {
				grid.push({ id: `${cx}-${cy}-hi`, ax: cx * 84 + 10, ay: cy * 84 + 10, priority: 1 });
				grid.push({ id: `${cx}-${cy}-lo`, ax: cx * 84 + 20, ay: cy * 84 + 20, priority: 0 });
			}
		}
		const keep = selectVisible(grid, 84, 1, 100);
		expect(keep.size).toBe(9); // one per occupied cell
		expect([...keep].every((id) => id.endsWith('-hi'))).toBe(true); // the higher-priority one
	});

	test('keeps a high-priority group intact while trimming a co-celled neighbour', () => {
		// The item-label case: a selected venue's whole 10-item cluster (highest priority)
		// shares a screen cell with a neighbour venue's 4 items. A perCell of 12 keeps the
		// cluster intact — a venue's labels are contiguous in priority — and trims the rest.
		const labels: LabelAnchor[] = [];
		for (let i = 0; i < 10; i++)
			labels.push({ id: `sel-${i}`, ax: 200, ay: 200, priority: 100 - i });
		for (let i = 0; i < 4; i++) labels.push({ id: `nb-${i}`, ax: 210, ay: 205, priority: 50 - i });
		const keep = selectVisible(labels, 84, 12, 80);
		expect(keep.size).toBe(12);
		for (let i = 0; i < 10; i++) expect(keep.has(`sel-${i}`)).toBe(true); // cluster intact
		expect(keep.has('nb-0')).toBe(true); // plus the neighbour's top two
		expect(keep.has('nb-1')).toBe(true);
		expect(keep.has('nb-2')).toBe(false); // and not the rest
		expect(keep.has('nb-3')).toBe(false);
	});

	test('does not mutate the input array', () => {
		const copy = [...anchors];
		selectVisible(anchors, 84, 1, 100);
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
		expect(maxBoxOverlap(nodes)).toBeLessThan(2);
		// Each pill ends near its own coordinate (only a modest nudge was needed to part).
		for (const n of nodes) expect(Math.hypot(n.ox, n.oy)).toBeLessThan(40);
	});
});

describe('LabelEngine', () => {
	// A fake projector: screen = anchor at (originX + lng*10, lat*10), so shifting
	// originX mimics a horizontal pan of the whole camera.
	const makeOpts = (candidates: Candidate[], selectedId: string | null, originX: number) => ({
		candidates,
		project: (lng: number, lat: number) => ({ x: originX + lng * 10, y: lat * 10 }),
		width: 1000,
		height: 1000,
		margin: 80,
		selectedId,
		cellSize: 42,
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
			cellSize: 1,
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
			cellSize: 84,
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
