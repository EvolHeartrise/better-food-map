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

const CFG: SimConfig = { spring: 0.08, damping: 0.75, separation: 0.6, padding: 6, maxLeader: 64 };

const absX = (n: SimNode) => n.ax + n.ox;
const absY = (n: SimNode) => n.ay + n.oy;
const overlaps = (a: SimNode, b: SimNode) =>
	Math.abs(absX(a) - absX(b)) < a.hw + b.hw && Math.abs(absY(a) - absY(b)) < a.hh + b.hh;

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

	test('hitTest returns the pill under a point, with slop, else null', () => {
		const engine = new LabelEngine();
		engine.recompute({
			candidates: [{ id: 'p', name: 'Pizza', lat: 300, lng: 200 }],
			project: (lng: number, lat: number) => ({ x: lng, y: lat }),
			width: 1000,
			height: 1000,
			margin: 80,
			selectedId: null,
			gap: 42,
			max: 100
		});
		engine.attach('p', null as unknown as HTMLElement, 30, 11); // measured half-extents
		expect(engine.hitTest(210, 305)).toBe('p'); // inside the box
		expect(engine.hitTest(235, 305)).toBeNull(); // outside (box half-width 30 → edge at 230)
		expect(engine.hitTest(235, 305, 6)).toBe('p'); // slop reaches it
		expect(engine.hitTest(700, 700)).toBeNull(); // far away
	});
});
