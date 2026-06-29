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

// Mirrors the component's shared SIM_CONFIG (one unified pass over name pills + item
// labels): the conservative radial "soft circle" repulsion (radiusBlend 1) that fans a
// co-anchored cluster into a round blob, with a leader clamp generous enough to hold it.
const CFG: SimConfig = {
	spring: 0.05,
	damping: 0.84,
	separation: 0.55,
	padding: 14,
	maxLeader: 130,
	radiusBlend: 1
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

// The component's settle threshold: the rAF loop parks once every pill's kinetic
// energy (vx²+vy²) has stayed below this for a stretch of frames.
const SETTLE_KE_EPS = 0.0016;

// Steps the simulation and returns the frame on which it SETTLED — the first frame of
// the run where max kinetic energy fell below SETTLE_KE_EPS and stayed there for 60
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

// A co-anchored item pill, seeded on the same hashed ring the engine uses, so the test
// fixtures match how production breaks the symmetry of a venue's whole menu.
const seeded = (
	id: string,
	hw: number,
	hh = 10,
	ax = 300,
	ay = 220,
	springScale?: number
): SimNode => {
	const angle = hashId(id) * 2 * Math.PI;
	return {
		id,
		ax,
		ay,
		ox: Math.cos(angle) * 10,
		oy: Math.sin(angle) * 10,
		vx: 0,
		vy: 0,
		hw,
		hh,
		springScale
	};
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
		{ id: 'b', ax: 110, ay: 105, priority: 0.5 }, // ~11px from a → too close
		{ id: 'c', ax: 400, ay: 400, priority: 0.1 } // far → kept
	];

	test('keeps the higher-priority pill of a too-close pair', () => {
		const keep = selectVisible(anchors, 42, 100);
		expect(keep.has('a')).toBe(true);
		expect(keep.has('b')).toBe(false);
	});

	test('keeps a far-apart pill', () => {
		expect(selectVisible(anchors, 42, 100).has('c')).toBe(true);
	});

	test('honours the max cap', () => {
		expect(selectVisible(anchors, 42, 1).size).toBe(1);
	});

	test('does not mutate the input array', () => {
		const copy = [...anchors];
		selectVisible(anchors, 42, 100);
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

	test('overlapping pills fan apart and stay within maxLeader', () => {
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

	test('a rigid pan of every anchor leaves the spread unchanged (no pan lag)', () => {
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

	test('a realistic co-anchored menu cluster SETTLES, overlap-free and radial', () => {
		// Eight item pills (mixed real-name widths) all springing to one venue point —
		// the case the old axis-aligned push left in a never-settling vertical pile. The
		// non-negotiable: the conservative radial model must reach a rest state the rAF
		// loop can park on, with the cluster spread round (not stacked) and not overlapping.
		const widths = [30, 40, 50, 35, 45, 55, 40, 50];
		const nodes = widths.map((hw, i) => seeded(`item-${i}`, hw));

		const settled = settleStep(nodes, CFG);
		// It settles (and well within a reasonable transient, not just before the cap).
		expect(settled).toBeGreaterThanOrEqual(0);
		expect(settled).toBeLessThan(600);

		// Overlap-free (a hair of sub-pixel penetration from finite stiffness is fine).
		expect(maxBoxOverlap(nodes)).toBeLessThan(5);

		// Radial: the cluster of pill centres occupies BOTH dimensions substantially —
		// i.e. it surrounds the point rather than collapsing onto one axis (a stack would
		// leave the horizontal span near zero). Also every pill stays within its leader.
		const xs = nodes.map((n) => n.ox);
		const ys = nodes.map((n) => n.oy);
		const spanX = Math.max(...xs) - Math.min(...xs);
		const spanY = Math.max(...ys) - Math.min(...ys);
		expect(spanX).toBeGreaterThan(60);
		expect(spanY).toBeGreaterThan(60);
		for (const n of nodes) expect(Math.hypot(n.ox, n.oy)).toBeLessThanOrEqual(CFG.maxLeader + 0.5);
	});

	test('a name pill (springScale) holds near its dot while items fan around it', () => {
		// A venue name pill (springScale > 1) co-anchored with its menu items: it must end
		// up nearer the shared point than the items, which ring out around it.
		const name = seeded('name', 50, 11, 300, 220, 8);
		const items = [30, 40, 50, 35, 45, 55, 40, 50].map((hw, i) => seeded(`item-${i}`, hw));
		const nodes = [name, ...items];

		expect(settleStep(nodes, CFG)).toBeGreaterThanOrEqual(0);

		const nameOffset = Math.hypot(name.ox, name.oy);
		const maxItemOffset = Math.max(...items.map((n) => Math.hypot(n.ox, n.oy)));
		expect(nameOffset).toBeLessThan(50); // stays near its dot
		expect(nameOffset).toBeLessThan(maxItemOffset); // and nearer than the items fan out
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
		gap: 42,
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

	test('co-anchored radial-seeded nodes fan apart without overlap and stay within maxLeader', () => {
		// Four labels sharing ONE anchor (a venue's menu) — the case that used to
		// collapse into an exact vertical pile when every node seeded at offset (0, 0).
		const engine = new LabelEngine();
		const co: Candidate[] = Array.from({ length: 4 }, (_, i) => ({
			id: `item-${i}`,
			name: `Item ${i}`,
			lat: 10,
			lng: 10
		}));
		const project = (lng: number, lat: number) => ({ x: lng * 10, y: lat * 10 });
		// gap 0: co-anchored items never declutter by distance, so all four survive and
		// the force model is what fans them out.
		engine.recompute({
			candidates: co,
			project,
			width: 1000,
			height: 1000,
			margin: 80,
			selectedId: null,
			gap: 0,
			max: 100
		});
		// Give every pill a measured box so the collision has something to separate.
		for (const c of co) engine.attach(c.id, null as unknown as HTMLElement, 30, 11);
		let nodes: SimNode[] = [];
		for (let i = 0; i < 800; i++) nodes = engine.tick(project, CFG);
		expect(nodes.length).toBe(co.length);
		// The hashed seed offsets broke the symmetry, so the cluster fanned out from the
		// shared origin instead of piling up at it: every pill ended up displaced...
		for (const n of nodes) {
			expect(Math.hypot(n.ox, n.oy)).toBeGreaterThan(0.5);
		}
		// ...no two boxes overlap...
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				expect(overlaps(nodes[i], nodes[j])).toBe(false);
			}
		}
		// ...and each stays tethered within the leader clamp.
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
			gap: 42,
			max: 100
		});
		engine.attach('p', null as unknown as HTMLElement, 30, 11); // measured half-extents
		// A new node is seeded on a small ring (see recompute); settle the lone pill back
		// onto its origin (zero offset) so its box sits exactly on its anchor below.
		for (let i = 0; i < 400; i++) engine.tick(project, CFG);
		expect(engine.hitTest(210, 305)).toBe('p'); // inside the box
		expect(engine.hitTest(235, 305)).toBeNull(); // outside (box half-width 30 → edge at 230)
		expect(engine.hitTest(235, 305, 6)).toBe('p'); // slop reaches it
		expect(engine.hitTest(700, 700)).toBeNull(); // far away
	});
});
