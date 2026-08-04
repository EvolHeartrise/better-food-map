import { describe, expect, test } from 'bun:test';
import { analyzeNameFidelity, deriveRun, levenshtein, provenanceLabel } from './derive';
import { toRunRecord, type RunRecord } from './record';

function run(overrides: Record<string, unknown> = {}): RunRecord {
	return toRunRecord({
		task: 'newyorkfries',
		dirName: '2026-08-04T19:40:31.039Z-m',
		dir: 'x',
		meta: {
			model: 'm',
			backend: 'openrouter',
			status: 'scored',
			started_at: '2026-08-04T19:40:31.039Z',
			duration_ms: 10_000,
			wall_clock_ms: 10_500,
			prompt_tokens: 1000,
			cached_prompt_tokens: 250,
			completion_tokens: 500,
			...overrides
		},
		report: null
	});
}

describe('deriveRun', () => {
	test('cost comes from openrouter price', () => {
		const derived = deriveRun(run({ price: 0.004 }));
		expect(derived.cost_usd).toBe(0.004);
		expect(derived.cost_source).toBe('openrouter-usage');
	});

	test('cost falls back to the claude backend total_cost_usd', () => {
		const derived = deriveRun(run({ backend: 'claude', total_cost_usd: 0.02 }));
		expect(derived.cost_usd).toBe(0.02);
		expect(derived.cost_source).toBe('claude-sdk');
	});

	test('no reported cost is unknown, not free', () => {
		const derived = deriveRun(run());
		expect(derived.cost_usd).toBeNull();
		expect(derived.cost_source).toBeNull();
	});

	test('cache hit rate, throughput and bench overhead', () => {
		const derived = deriveRun(run());
		expect(derived.cache_hit_rate).toBeCloseTo(0.25);
		expect(derived.output_tok_per_s).toBeCloseTo(50);
		expect(derived.bench_overhead_ms).toBe(500);
	});

	test('a genuine zero cache read is 0, while missing tokens are null', () => {
		expect(deriveRun(run({ cached_prompt_tokens: 0 })).cache_hit_rate).toBe(0);
		expect(deriveRun(run({ prompt_tokens: undefined })).cache_hit_rate).toBeNull();
	});

	test('overhead needs both durations', () => {
		expect(deriveRun(run({ wall_clock_ms: undefined })).bench_overhead_ms).toBeNull();
	});

	test('reroute is flagged only with more than one provider', () => {
		expect(deriveRun(run({ providers: ['GMICloud'] })).rerouted).toBe(false);
		expect(deriveRun(run({ providers: ['GMICloud', 'DeepInfra'] })).rerouted).toBe(true);
	});
});

describe('provenanceLabel', () => {
	test('unknown provider is stated, not blanked', () => {
		expect(provenanceLabel(run())).toBe('provider unknown · unpinned');
	});

	test('an unpinned run is labelled unpinned, never "unquantized"', () => {
		const label = provenanceLabel(run({ providers: ['DeepInfra'] }));
		expect(label).toContain('unpinned');
		expect(label).not.toContain('unquantized');
	});

	test('provider and tier are shown together', () => {
		expect(
			provenanceLabel(
				run({
					providers: ['GMICloud'],
					provider_quantizations: { GMICloud: 'fp8' },
					quantization_requested: ['fp8']
				})
			)
		).toBe('GMICloud@fp8 · pinned:fp8');
	});

	test('a missing tier reads as unknown, not as absent quantization', () => {
		expect(provenanceLabel(run({ providers: ['GMICloud'] }))).toBe('GMICloud@? · unpinned');
	});

	test('an empty providers array is distinguished from an absent one', () => {
		expect(provenanceLabel(run({ providers: [] }))).toContain('unreported');
		expect(provenanceLabel(run())).toContain('unknown');
	});

	test('a re-routed run names both providers', () => {
		expect(
			provenanceLabel(
				run({
					providers: ['GMICloud', 'DeepInfra'],
					provider_quantizations: { GMICloud: 'fp8', DeepInfra: 'fp4' }
				})
			)
		).toBe('GMICloud@fp8 + DeepInfra@fp4 · unpinned');
	});
});

describe('levenshtein', () => {
	test('basic distances', () => {
		expect(levenshtein('abc', 'abc')).toBe(0);
		expect(levenshtein('', 'abc')).toBe(3);
		expect(levenshtein('kitten', 'sitting')).toBe(3);
	});
});

describe('analyzeNameFidelity', () => {
	test('a dropped apostrophe reads as a rename, not a miss plus a hallucination', () => {
		// The real newyorkfries case: gold "Flamin' Bacon Dog" vs candidate
		// "Flamin Bacon Dog" costs the scorer one miss AND one hallucination.
		const result = analyzeNameFidelity(["Flamin' Bacon Dog"], ['Flamin Bacon Dog']);
		expect(result.renamed).toHaveLength(1);
		expect(result.renamed[0].gold).toBe("Flamin' Bacon Dog");
		expect(result.renamed[0].candidate).toBe('Flamin Bacon Dog');
		expect(result.true_misses).toEqual([]);
		expect(result.true_hallucinations).toEqual([]);
	});

	test('genuinely different dishes stay unpaired', () => {
		const result = analyzeNameFidelity(['Poutine Kit'], ['Chocolate Sundae']);
		expect(result.renamed).toEqual([]);
		expect(result.true_misses).toEqual(['Poutine Kit']);
		expect(result.true_hallucinations).toEqual(['Chocolate Sundae']);
	});

	test('each side is consumed at most once', () => {
		const result = analyzeNameFidelity(
			['Classic Poutine', 'Classic Poutines'],
			['Classic Poutine!']
		);
		expect(result.renamed).toHaveLength(1);
		expect(result.true_misses).toHaveLength(1);
		expect(result.true_hallucinations).toEqual([]);
	});

	test('the best pairing wins regardless of input order', () => {
		const forward = analyzeNameFidelity(['Veggie Dog'], ['Veggie Dogg', 'Veggie Burger']);
		expect(forward.renamed[0].candidate).toBe('Veggie Dogg');
		const reversed = analyzeNameFidelity(['Veggie Dog'], ['Veggie Burger', 'Veggie Dogg']);
		expect(reversed.renamed[0].candidate).toBe('Veggie Dogg');
	});

	test('empty inputs yield empty output', () => {
		const result = analyzeNameFidelity([], []);
		expect(result.renamed).toEqual([]);
		expect(result.true_misses).toEqual([]);
		expect(result.true_hallucinations).toEqual([]);
	});

	test('identical match keys are not a "rename" — the scorer would have matched them', () => {
		const result = analyzeNameFidelity(['Fresh Soup (Bowl)'], ['Fresh Soup Bowl']);
		expect(result.renamed).toEqual([]);
		expect(result.true_misses).toEqual(['Fresh Soup (Bowl)']);
		expect(result.true_hallucinations).toEqual(['Fresh Soup Bowl']);
	});

	test('a repeated hallucinated name is not swallowed by one pairing', () => {
		// Real case: a meetonmain run repeated "PHILIPS TILT LAGER (Happy Hour)".
		// Tracking used names (not occurrences) deleted every copy from the residual
		// bucket, so items were reported nowhere at all.
		const result = analyzeNameFidelity(
			['Chili Cheese Dog'],
			['Chili Cheese Dogg', 'Chili Cheese Dogg']
		);
		expect(result.renamed).toHaveLength(1);
		expect(result.true_hallucinations).toEqual(['Chili Cheese Dogg']);
		expect(result.renamed.length + result.true_hallucinations.length).toBe(2);
	});

	test('a duplicate of a DIFFERENT gold item is not read as a rename', () => {
		// Real case: newyorkfries gold has both "Bacon Double Cheese" (a poutine)
		// and "Bacon Double Cheese Dog". A model emitted "BACON DOUBLE CHEESE"
		// twice; pairing the extra copy with the Dog hid genuinely missed items.
		const result = analyzeNameFidelity(['Bacon Double Cheese Dog'], ['BACON DOUBLE CHEESE'], {
			goldNames: ['Bacon Double Cheese', 'Bacon Double Cheese Dog'],
			candidateNames: ['Bacon Double Cheese', 'BACON DOUBLE CHEESE']
		});
		expect(result.renamed).toEqual([]);
		expect(result.true_misses).toEqual(['Bacon Double Cheese Dog']);
		expect(result.true_hallucinations).toEqual(['BACON DOUBLE CHEESE']);
	});

	test('size variants are different items, not typos', () => {
		// "(5 oz)" vs "(9 oz glass)" sit 0.125 apart — inside the threshold — but
		// the bench's variant convention makes them separate menu items.
		const result = analyzeNameFidelity(
			['Stone Road Smooth Red, BC VQA (9 oz glass)'],
			['Stone Road Smooth Red, BC VQA (5 oz)']
		);
		expect(result.renamed).toEqual([]);
		expect(result.true_misses).toHaveLength(1);
		expect(result.true_hallucinations).toHaveLength(1);
	});

	test('every miss and hallucination is accounted for exactly once', () => {
		const missed = ['Alpha Dog', 'Beta Fries', 'Gamma Poutine'];
		const hallucinated = ['Alpha Dogg', 'Delta Shake', 'Delta Shake'];
		const result = analyzeNameFidelity(missed, hallucinated);
		expect(result.renamed.length + result.true_misses.length).toBe(missed.length);
		expect(result.renamed.length + result.true_hallucinations.length).toBe(hallucinated.length);
	});
});
