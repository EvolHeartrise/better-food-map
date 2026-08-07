import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { GoldSchema, type GoldMenu } from './lint';
import { scoreCandidate } from './score';
import { SnapshotStore } from './snapshot-store';
import {
	buildMeta,
	buildOpenRouterBody,
	capText,
	estimateCachedPrice,
	extractHrefs,
	fetchPage,
	formatDuration,
	formatProvenance,
	formatWallClock,
	modelSlug,
	normalizeAssistantMessage,
	parseCli,
	runAgent,
	stripTrailingJunk,
	sumRealCost,
	validateRequestedParams,
	validateSubmission,
	type ChatFn,
	type ChatMessage,
	type ChatResponse,
	type ChatUsage,
	type CliArgs,
	type ModelPricing,
	type RunMeta,
	type RunResult,
	type TranscriptEvent
} from './run';
import type { BenchManifest } from './snapshot-store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function withStore(fn: (store: SnapshotStore) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'bench-run-'));
	try {
		fn(new SnapshotStore(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function toolCallResponse(name: string, args: unknown, id = 'call_1'): ChatResponse {
	return {
		choices: [
			{
				message: {
					role: 'assistant',
					content: null,
					tool_calls: [
						{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
					]
				}
			}
		],
		usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
	};
}

/** A chat driver that replays scripted steps; each step may inspect the messages. */
function scriptedChat(
	steps: (ChatResponse | ((messages: Parameters<ChatFn>[0]) => ChatResponse))[]
): ChatFn {
	let i = 0;
	return async (messages) => {
		const step = steps[i++];
		if (step === undefined) throw new Error('scriptedChat: no more steps');
		return typeof step === 'function' ? step(messages) : step;
	};
}

describe('extractHrefs', () => {
	test('resolves relative and absolute hrefs across all hosts, dedupes, drops non-http', () => {
		const html =
			'<a href="/menu">m</a><a href=\'drinks.html\'>d</a>' +
			'<a href="https://other.com/pdf#x">p</a><a href="mailto:a@b.c">e</a>' +
			'<a href="/menu">dup</a>';
		expect(extractHrefs(html, 'https://x.com/home/')).toEqual([
			'https://x.com/menu',
			'https://x.com/home/drinks.html',
			'https://other.com/pdf'
		]);
	});
});

describe('capText', () => {
	test('leaves short text alone and marks truncation', () => {
		expect(capText('hi')).toBe('hi');
		const big = 'a'.repeat(70_000);
		const out = capText(big);
		expect(out).toContain('[truncated: 60000 of 70000 chars]');
		expect(out.startsWith('a'.repeat(60_000))).toBe(true);
	});
});

describe('modelSlug', () => {
	test('replaces / and : with -', () => {
		expect(modelSlug('anthropic/claude-3.5:beta')).toBe('anthropic-claude-3.5-beta');
	});
});

describe('fetchPage', () => {
	test('prefers rendered DOM and extracts links from the rendered html', () => {
		withStore((store) => {
			store.put({
				method: 'GET',
				url: 'https://x.com/menu',
				status: 200,
				contentType: 'text/html',
				body: enc('<p>raw body text</p>')
			});
			store.putRendered(
				'https://x.com/menu',
				'<html><body><h1>Rendered Menu</h1><a href="/drinks">Drinks</a>' +
					'<a href="https://cdn.x.com/food.pdf">pdf</a></body></html>'
			);
			const result = fetchPage(store, 'https://x.com/menu');
			if ('note' in result) throw new Error('expected a page, got a miss');
			expect(result.text).toContain('Rendered Menu');
			expect(result.text).not.toContain('raw body text');
			expect(result.links).toEqual(['https://x.com/drinks', 'https://cdn.x.com/food.pdf']);
		});
	});

	test('scheme swap resolves an http entry for an https request', () => {
		withStore((store) => {
			store.put({
				method: 'GET',
				url: 'http://x.com/menu',
				status: 200,
				contentType: 'text/html',
				body: enc('<p>Hello</p>')
			});
			const result = fetchPage(store, 'https://x.com/menu');
			if ('note' in result) throw new Error('expected a page, got a miss');
			expect(result.text).toContain('Hello');
		});
	});

	test('passes JSON bodies through and truncates over the cap', () => {
		withStore((store) => {
			const payload = JSON.stringify({ pad: 'z'.repeat(70_000) });
			store.put({
				method: 'GET',
				url: 'https://x.com/api',
				status: 200,
				contentType: 'application/json',
				body: enc(payload)
			});
			const result = fetchPage(store, 'https://x.com/api');
			if ('note' in result) throw new Error('expected a page, got a miss');
			expect(result.text).toContain(`[truncated: 60000 of ${payload.length} chars]`);
			expect(result.links).toBeUndefined();
		});
	});

	test('returns a PDF stub without extracting text', () => {
		withStore((store) => {
			store.put({
				method: 'GET',
				url: 'https://x.com/menu.pdf',
				status: 200,
				contentType: 'application/pdf',
				body: enc('%PDF-1.4 ...')
			});
			const result = fetchPage(store, 'https://x.com/menu.pdf');
			if ('note' in result) throw new Error('expected a page, got a miss');
			expect(result.text).toContain('[PDF document,');
			expect(result.text).toContain('text extraction not supported');
		});
	});

	test('a URL not in the snapshot returns a 404 note', () => {
		withStore((store) => {
			expect(fetchPage(store, 'https://x.com/nope')).toEqual({
				status: 404,
				note: 'not in snapshot'
			});
			expect(fetchPage(store, 'not a url')).toEqual({ status: 404, note: 'not in snapshot' });
		});
	});
});

describe('stripTrailingJunk', () => {
	test('strips the live list-delimiter artifact down to the trailing period', () => {
		const artifact =
			"Delicious sooji papdi with our special combination of yogurt, spices, chutneys, onions and potatoes.', ";
		const cleaned = stripTrailingJunk(artifact);
		expect(cleaned).toBe(
			'Delicious sooji papdi with our special combination of yogurt, spices, chutneys, onions and potatoes.'
		);
		expect(cleaned.endsWith('potatoes.')).toBe(true);
	});

	test('removes a plain trailing comma but keeps a trailing period', () => {
		expect(stripTrailingJunk('mashed potatoes,')).toBe('mashed potatoes');
		expect(stripTrailingJunk('mashed potatoes.')).toBe('mashed potatoes.');
	});

	test('leaves a clean string untouched', () => {
		expect(stripTrailingJunk('Grilled halloumi with mint')).toBe('Grilled halloumi with mint');
	});

	test('returns a pure-junk string unchanged rather than emptying it', () => {
		const junk = '  ,\'," `’‘“”';
		expect(stripTrailingJunk(junk)).toBe(junk);
	});

	test('never touches junk in the interior — only the tail is stripped', () => {
		expect(stripTrailingJunk("a, b, c and 'd'")).toBe("a, b, c and 'd");
		expect(stripTrailingJunk('yogurt, spices, chutneys')).toBe('yogurt, spices, chutneys');
	});
});

describe('sumRealCost', () => {
	test('sums per-request usage.cost values', () => {
		const usages: ChatUsage[] = [{ cost: 0.0069415 }, { cost: 0.0043366 }, { cost: 0.0110536 }];
		expect(sumRealCost(usages)).toBeCloseTo(0.0223317, 10);
	});

	test('returns null when no request carried a cost, skipping cost-less requests', () => {
		expect(sumRealCost([{ prompt_tokens: 10 }, {}])).toBeNull();
		// a cost-less request is skipped (not counted as 0), a $0 run is still a number
		expect(sumRealCost([{ cost: 0.5 }, { prompt_tokens: 10 }])).toBeCloseTo(0.5, 10);
		expect(sumRealCost([{ cost: 0 }])).toBe(0);
	});
});

describe('estimateCachedPrice', () => {
	// prompt $3/M, completion $15/M, cache-read $0.30/M (per-token USD).
	const pricing: ModelPricing = { prompt: 3e-6, completion: 15e-6, cacheRead: 0.3e-6 };

	test('bills the append-only prefix at the cache-read rate, the remainder at prompt rate', () => {
		// 3 requests, promptTotal 1000/1500/2000, completion 100 each.
		//   req1 (uncached): 1000*3e-6 + 100*15e-6                 = 0.00450
		//   req2: cached 1000*0.3e-6 + fresh 500*3e-6 + 100*15e-6  = 0.00330
		//   req3: cached 1500*0.3e-6 + fresh 500*3e-6 + 100*15e-6  = 0.00345
		const seq = [
			{ promptTotal: 1000, completion: 100 },
			{ promptTotal: 1500, completion: 100 },
			{ promptTotal: 2000, completion: 100 }
		];
		expect(estimateCachedPrice(seq, pricing)).toBeCloseTo(0.01125, 10);
	});

	test('a single request is fully uncached', () => {
		expect(estimateCachedPrice([{ promptTotal: 1000, completion: 100 }], pricing)).toBeCloseTo(
			0.0045,
			10
		);
	});

	test('an empty sequence costs nothing', () => {
		expect(estimateCachedPrice([], pricing)).toBe(0);
	});
});

describe('validateRequestedParams', () => {
	// A model that supports reasoning + reasoning_effort but NOT temperature
	// (mirrors anthropic/claude-sonnet-5 on OpenRouter).
	const reasoningOnly = ['reasoning', 'reasoning_effort', 'tools', 'tool_choice'];
	// A model whose only reasoning knob is reasoning_effort (no bare `reasoning`).
	const effortAlias = ['reasoning_effort', 'temperature', 'tools'];
	// A model that supports temperature but no reasoning at all.
	const tempOnly = ['temperature', 'tools', 'top_p'];

	test('effort ok when `reasoning` is supported', () => {
		expect(validateRequestedParams({ effort: 'high' }, reasoningOnly)).toBeNull();
	});

	test('effort ok when only `reasoning_effort` is supported', () => {
		expect(validateRequestedParams({ effort: 'high' }, effortAlias)).toBeNull();
	});

	test('effort rejected when neither reasoning knob is present', () => {
		const err = validateRequestedParams({ effort: 'high' }, tempOnly);
		expect(err).not.toBeNull();
		expect(err).toContain('reasoning effort');
		expect(err).toContain('--effort');
		// the actual supported list is surfaced so the user sees what IS available
		expect(err).toContain('temperature');
	});

	test('temperature ok when `temperature` is supported', () => {
		expect(validateRequestedParams({ temperature: 0.5 }, tempOnly)).toBeNull();
	});

	test('temperature rejected when `temperature` is absent (e.g. Sonnet 5)', () => {
		const err = validateRequestedParams({ temperature: 0.5 }, reasoningOnly);
		expect(err).not.toBeNull();
		expect(err).toContain('temperature');
		expect(err).toContain('--temperature');
		expect(err).toContain('reasoning_effort'); // the supported list is included
	});

	test('neither flag requested → null passthrough even when nothing is supported', () => {
		expect(validateRequestedParams({}, [])).toBeNull();
	});

	test('null supportedParameters is unknowable → always null (never blocks a run)', () => {
		expect(validateRequestedParams({ effort: 'high' }, null)).toBeNull();
		expect(validateRequestedParams({ temperature: 0.5 }, null)).toBeNull();
		expect(validateRequestedParams({ effort: 'max', temperature: 1 }, null)).toBeNull();
	});
});

describe('validateSubmission', () => {
	test('accepts a valid candidate and reports issues for an invalid one', () => {
		const good = validateSubmission({
			sources: ['https://x.com/menu'],
			items: [{ name: 'A', description: null, tags: [], optional_tags: [], price: 1 }]
		});
		expect(good.ok).toBe(true);
		const bad = validateSubmission({
			sources: ['https://x.com/menu'],
			items: [{ name: 'A', description: null, tags: ['not_a_tag'], optional_tags: [], price: 1 }]
		});
		expect(bad.ok).toBe(false);
		if (bad.ok) throw new Error('expected failure');
		expect(bad.issues.length).toBeGreaterThan(0);
	});
});

const GOLD: GoldMenu = v.parse(GoldSchema, {
	policy_version: '2026-07-11',
	sources: ['https://x.com/menu'],
	items: [
		{ name: 'Samosa', description: null, tags: ['vegan'], optional_tags: [], price: 3.99 },
		{ name: 'Chai', description: null, tags: ['vegetarian'], optional_tags: [], price: 2.5 }
	]
});

describe('runAgent', () => {
	test('submit validation failure returns issues, then succeeds on retry', async () => {
		await withStoreAsync(async (store) => {
			const transcript: TranscriptEvent[] = [];
			let sawIssues = false;
			const chat = scriptedChat([
				toolCallResponse('submit_menu', {
					sources: ['https://x.com/menu'],
					items: [
						{ name: 'Samosa', description: null, tags: ['bogus'], optional_tags: [], price: 3.99 }
					]
				}),
				(messages) => {
					const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
					if (lastTool && String(lastTool.content).includes('issues')) sawIssues = true;
					return toolCallResponse('submit_menu', {
						sources: ['https://x.com/menu'],
						items: [
							{ name: 'Samosa', description: null, tags: ['vegan'], optional_tags: [], price: 3.99 }
						]
					});
				}
			]);
			const result = await runAgent({
				chat,
				store,
				entryUrl: 'https://x.com/',
				maxToolCalls: 40,
				transcript
			});
			expect(sawIssues).toBe(true);
			expect(result.status).toBe('scored');
			expect(result.submitAttempts).toBe(2);
			expect(result.candidate?.items).toHaveLength(1);
		});
	});

	test('sanitizes trailing junk on a submitted description, preserving the raw text in the transcript', async () => {
		await withStoreAsync(async (store) => {
			const transcript: TranscriptEvent[] = [];
			const rawDescription =
				"Delicious sooji papdi with our special combination of yogurt, spices, chutneys, onions and potatoes.', ";
			const chat = scriptedChat([
				toolCallResponse('submit_menu', {
					sources: ['https://x.com/menu'],
					items: [
						{
							name: 'Sooji Papdi',
							description: rawDescription,
							tags: [],
							optional_tags: [],
							price: 5.99
						}
					]
				})
			]);
			const result = await runAgent({
				chat,
				store,
				entryUrl: 'https://x.com/',
				maxToolCalls: 40,
				transcript
			});
			expect(result.status).toBe('scored');
			// candidate description is sanitized...
			expect(result.candidate?.items[0].description).toBe(
				'Delicious sooji papdi with our special combination of yogurt, spices, chutneys, onions and potatoes.'
			);
			// ...but the transcript's tool_call event still holds the raw submitted text.
			const submitCall = transcript.find((e) => e.type === 'tool_call' && e.name === 'submit_menu');
			if (!submitCall) throw new Error('expected a submit_menu tool_call event');
			const args = submitCall.arguments as { items: { description: string }[] };
			expect(args.items[0].description).toBe(rawDescription);
		});
	});

	test('aborts when max tool calls is exceeded', async () => {
		await withStoreAsync(async (store) => {
			const transcript: TranscriptEvent[] = [];
			const chat: ChatFn = async () =>
				toolCallResponse('fetch_page', { url: 'https://x.com/menu' });
			const result = await runAgent({
				chat,
				store,
				entryUrl: 'https://x.com/',
				maxToolCalls: 1,
				transcript
			});
			expect(result.status).toBe('failed');
			expect(result.failureReason).toContain('max tool calls');
			expect(result.toolCalls).toBe(2);
		});
	});

	test('nudges once, then aborts if the model still does not submit', async () => {
		await withStoreAsync(async (store) => {
			const transcript: TranscriptEvent[] = [];
			const plain: ChatResponse = {
				choices: [{ message: { role: 'assistant', content: 'I am thinking.' } }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
			};
			const result = await runAgent({
				chat: scriptedChat([plain, plain]),
				store,
				entryUrl: 'https://x.com/',
				maxToolCalls: 40,
				transcript
			});
			expect(result.status).toBe('failed');
			expect(result.failureReason).toContain('without submitting');
			expect(transcript.some((e) => e.type === 'note')).toBe(true);
		});
	});

	test('full 3-turn run (fetch → fetch → submit) produces a scored report', async () => {
		await withStoreAsync(async (store) => {
			store.put({
				method: 'GET',
				url: 'https://x.com/menu',
				status: 200,
				contentType: 'text/html',
				body: enc('<h1>Samosa $3.99</h1><a href="/drinks">Drinks</a>')
			});
			store.put({
				method: 'GET',
				url: 'https://x.com/drinks',
				status: 200,
				contentType: 'text/html',
				body: enc('<h1>Chai $2.50</h1>')
			});
			const transcript: TranscriptEvent[] = [];
			const chat = scriptedChat([
				toolCallResponse('fetch_page', { url: 'https://x.com/menu' }),
				toolCallResponse('fetch_page', { url: 'https://x.com/drinks' }),
				toolCallResponse('submit_menu', {
					sources: ['https://x.com/menu'],
					items: [
						{ name: 'Samosa', description: null, tags: ['vegan'], optional_tags: [], price: 3.99 },
						{ name: 'Chai', description: null, tags: ['vegetarian'], optional_tags: [], price: 2.5 }
					]
				})
			]);
			const result = await runAgent({
				chat,
				store,
				entryUrl: 'https://x.com/',
				maxToolCalls: 40,
				transcript
			});
			expect(result.status).toBe('scored');
			expect(result.toolCalls).toBe(3);
			expect(result.totalTokens).toBe(42);
			if (!result.candidate) throw new Error('expected a candidate');

			const report = scoreCandidate(GOLD, result.candidate);
			expect(report.matched).toBe(2);
			expect(report.item_recall).toBe(1);
			expect(report.price_accuracy).toBe(1);
			expect(report.tag_false_positives).toHaveLength(0);

			// transcript is replayable: request/response/tool_call/tool_result all present
			const kinds = new Set(transcript.map((e) => e.type));
			expect(kinds.has('request')).toBe(true);
			expect(kinds.has('response')).toBe(true);
			expect(kinds.has('tool_call')).toBe(true);
			expect(kinds.has('tool_result')).toBe(true);
		});
	});
});

async function withStoreAsync(fn: (store: SnapshotStore) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'bench-run-'));
	try {
		await fn(new SnapshotStore(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('parseCli --effort / --temperature', () => {
	function ok(argv: string[]): CliArgs {
		const cli = parseCli(argv);
		if ('error' in cli) throw new Error(cli.error);
		return cli;
	}

	test('effort/temperature are undefined by default', () => {
		const cli = ok(['bench/tasks/x', '--model', 'anthropic/claude']);
		expect(cli.effort).toBeUndefined();
		expect(cli.temperature).toBeUndefined();
	});

	test('openrouter accepts its effort levels, including minimal/none', () => {
		for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
			expect(ok(['bench/tasks/x', '--model', 'anthropic/claude', '--effort', level]).effort).toBe(
				level
			);
		}
	});

	test('rejects an unknown effort level, naming the backend levels', () => {
		const cli = parseCli(['bench/tasks/x', '--model', 'm', '--effort', 'ludicrous']);
		expect('error' in cli).toBe(true);
		if ('error' in cli) {
			expect(cli.error).toContain('--effort');
			expect(cli.error).toContain('openrouter');
		}
	});

	test('claude backend rejects minimal/none (not in EffortLevel) but accepts high/xhigh/max', () => {
		const bad = parseCli([
			'bench/tasks/x',
			'--model',
			'm',
			'--backend',
			'claude',
			'--effort',
			'minimal'
		]);
		expect('error' in bad).toBe(true);
		if ('error' in bad) expect(bad.error).toContain('claude');
		expect(
			ok(['bench/tasks/x', '--model', 'm', '--backend', 'claude', '--effort', 'xhigh']).effort
		).toBe('xhigh');
	});

	test('validates effort against the backend even when --backend comes after --effort', () => {
		const cli = parseCli([
			'bench/tasks/x',
			'--model',
			'm',
			'--effort',
			'none',
			'--backend',
			'claude'
		]);
		expect('error' in cli).toBe(true);
		if ('error' in cli) expect(cli.error).toContain('claude');
	});

	test('parses a finite temperature and rejects a non-numeric one', () => {
		expect(ok(['bench/tasks/x', '--model', 'm', '--temperature', '0.7']).temperature).toBe(0.7);
		expect(ok(['bench/tasks/x', '--model', 'm', '--temperature', '0']).temperature).toBe(0);
		for (const bad of ['abc', 'NaN', 'Infinity', '']) {
			const cli = parseCli(['bench/tasks/x', '--model', 'm', '--temperature', bad]);
			expect('error' in cli).toBe(true);
			if ('error' in cli) expect(cli.error).toContain('--temperature');
		}
	});

	test('temperature is rejected on the claude backend', () => {
		const cli = parseCli([
			'bench/tasks/x',
			'--model',
			'm',
			'--backend',
			'claude',
			'--temperature',
			'0.5'
		]);
		expect('error' in cli).toBe(true);
		if ('error' in cli) expect(cli.error).toContain('--temperature');
	});
});

describe('buildOpenRouterBody', () => {
	const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

	test('omits reasoning and temperature when unset', () => {
		const body = buildOpenRouterBody('openai/gpt-x', messages);
		expect('reasoning' in body).toBe(false);
		expect('temperature' in body).toBe(false);
		expect(body.messages).toBe(messages); // non-anthropic: passed through untouched
	});

	test('sets the unified reasoning.effort field when effort is given', () => {
		const body = buildOpenRouterBody('openai/gpt-x', messages, { effort: 'high' });
		expect(body.reasoning).toEqual({ effort: 'high' });
	});

	test('passes temperature through top-level without gating per model', () => {
		const body = buildOpenRouterBody('anthropic/claude-sonnet-5', messages, { temperature: 0.2 });
		expect(body.temperature).toBe(0.2);
	});

	test('carries both when both are set', () => {
		const body = buildOpenRouterBody('openai/gpt-x', messages, { effort: 'max', temperature: 1 });
		expect(body.reasoning).toEqual({ effort: 'max' });
		expect(body.temperature).toBe(1);
	});
});

describe('normalizeAssistantMessage', () => {
	test('fills empty content so a reasoning-only turn stays schema-valid', () => {
		// GMICloud 400s on {content: null, no tool_calls}; DeepInfra accepts it.
		expect(normalizeAssistantMessage({ role: 'assistant', content: null })).toEqual({
			role: 'assistant',
			content: ''
		});
		expect(normalizeAssistantMessage({ role: 'assistant' })).toEqual({
			role: 'assistant',
			content: ''
		});
		expect(normalizeAssistantMessage({ role: 'assistant', content: '', tool_calls: [] })).toEqual({
			role: 'assistant',
			content: '',
			tool_calls: []
		});
	});

	test('preserves the content and tool_calls of a turn that has them', () => {
		// Equality, not identity: the normalizer now returns a fresh object so it can
		// drop response-only fields (see the stripping test below).
		const withText = { role: 'assistant' as const, content: 'hi' };
		expect(normalizeAssistantMessage(withText)).toEqual(withText);
		const withCalls = {
			role: 'assistant' as const,
			content: null,
			tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }]
		};
		expect(normalizeAssistantMessage(withCalls)).toEqual(withCalls);
	});

	test('strips response-only provider fields so they are never echoed back', () => {
		// CoreWeave maps both `reasoning` and `reasoning_details` onto one
		// `reasoning_content` and 400s the request with "duplicate field
		// `reasoning_content`"; GMICloud and DeepInfra accept them. Echoing them
		// made run success depend on which endpoint OpenRouter routed to.
		const fromProvider = {
			role: 'assistant' as const,
			content: null,
			refusal: null,
			reasoning: 'thinking out loud',
			reasoning_details: [{ type: 'reasoning.text', text: 'x' }],
			tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }]
		} as ChatMessage;
		const out = normalizeAssistantMessage(fromProvider);
		expect(Object.keys(out).toSorted()).toEqual(['content', 'role', 'tool_calls']);
		for (const dropped of ['reasoning', 'reasoning_details', 'refusal']) {
			expect(out).not.toHaveProperty(dropped);
		}
		// The turn's real payload survives intact.
		expect(out.tool_calls).toHaveLength(1);
	});

	test('strips them on an empty turn too, where the 400 was first seen', () => {
		const out = normalizeAssistantMessage({
			role: 'assistant',
			content: null,
			reasoning: null,
			reasoning_details: []
		} as ChatMessage);
		expect(out).toEqual({ role: 'assistant', content: '' });
	});
});

describe('quantization pinning', () => {
	const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

	test('omits provider routing entirely when unpinned', () => {
		expect(buildOpenRouterBody('m', messages, {}).provider).toBeUndefined();
		expect(buildOpenRouterBody('m', messages, { quantizations: [] }).provider).toBeUndefined();
	});

	test('pins quantizations and disables fallbacks so the tier cannot silently widen', () => {
		expect(buildOpenRouterBody('m', messages, { quantizations: ['fp8'] }).provider).toEqual({
			quantizations: ['fp8'],
			allow_fallbacks: false
		});
	});

	test('parseCli accepts a single level and a comma list, rejecting typos', () => {
		const one = parseCli(['t', '--model', 'm', '--quantization', 'fp8']);
		expect((one as CliArgs).quantizations).toEqual(['fp8']);
		const many = parseCli(['t', '--model', 'm', '--quantization', 'fp8, bf16']);
		expect((many as CliArgs).quantizations).toEqual(['fp8', 'bf16']);
		expect(parseCli(['t', '--model', 'm', '--quantization', 'fp-8'])).toHaveProperty('error');
		expect(parseCli(['t', '--model', 'm', '--quantization'])).toEqual({
			error: '--quantization requires a value'
		});
	});

	test('rejected on the claude backend, which has no provider routing', () => {
		expect(parseCli(['t', '--model', 'm', '--backend', 'claude', '--quantization', 'fp8'])).toEqual(
			{
				error: '--quantization is not supported with --backend claude (no provider routing)'
			}
		);
	});
});

describe('provider capture + formatProvenance', () => {
	const store = new SnapshotStore(mkdtempSync(join(tmpdir(), 'bench-prov-')));

	test('runAgent records distinct providers in first-seen order', async () => {
		const submit = {
			sources: ['https://x.com/menu'],
			items: [{ name: 'A', description: null, tags: [], optional_tags: [], price: 1 }]
		};
		const chat: ChatFn = scriptedChat([
			{ ...toolCallResponse('fetch_page', { url: 'https://x.com/a' }), provider: 'DeepInfra' },
			{ ...toolCallResponse('fetch_page', { url: 'https://x.com/b' }), provider: 'DeepInfra' },
			{ ...toolCallResponse('submit_menu', submit), provider: 'Fireworks' }
		]);
		const result = await runAgent({
			chat,
			store,
			entryUrl: 'https://x.com/',
			maxToolCalls: 10,
			transcript: []
		});
		// Deduped, order preserved — two entries means a mid-run re-route.
		expect(result.providers).toEqual(['DeepInfra', 'Fireworks']);
	});

	const base = {
		providers: ['DeepInfra'],
		provider_quantizations: { DeepInfra: 'fp4' },
		quantization_requested: null
	} as unknown as RunMeta;

	test('names the provider, its quantization, and flags unpinned routing', () => {
		expect(formatProvenance(base)).toBe(
			'served by  DeepInfra @ fp4 [unpinned — OpenRouter default routing]'
		);
	});

	test('shows the pin when one was requested', () => {
		expect(formatProvenance({ ...base, quantization_requested: ['fp8'] })).toContain(
			'[pinned: fp8]'
		);
	});

	test('a missing quantization reads as unknown, never as unquantized', () => {
		expect(formatProvenance({ ...base, provider_quantizations: {} })).toContain(
			'DeepInfra (quantization unknown)'
		);
	});

	test('loudly flags a mid-run re-route', () => {
		expect(
			formatProvenance({
				...base,
				providers: ['DeepInfra', 'Fireworks'],
				provider_quantizations: { DeepInfra: 'fp4', Fireworks: 'unknown' }
			})
		).toContain('RE-ROUTED MID-RUN');
	});

	test('returns undefined when no provider was reported (e.g. claude backend)', () => {
		expect(formatProvenance({ ...base, providers: [] })).toBeUndefined();
	});
});

describe('buildMeta provenance fields', () => {
	const manifest = { entryUrl: 'https://x.com/' } as BenchManifest;
	const cli: CliArgs = {
		taskDir: 'bench/tasks/x',
		model: 'm',
		maxToolCalls: 40,
		backend: 'openrouter',
		harness: 'single-pass',
		quantizations: ['fp8']
	};
	const result: RunResult = {
		status: 'scored',
		toolCalls: 1,
		submitAttempts: 1,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedPromptTokens: 0,
		cacheWriteTokens: 0,
		usages: [],
		providers: ['DeepInfra']
	};

	test('records the pin, the providers used, and only their quantizations', () => {
		const meta = buildMeta(cli, manifest, 'p', new Date(), result, undefined, undefined, {
			DeepInfra: 'fp4',
			Fireworks: 'unknown'
		});
		expect(meta.quantization_requested).toEqual(['fp8']);
		expect(meta.providers).toEqual(['DeepInfra']);
		// Only providers this run actually used — not the whole endpoint table.
		expect(meta.provider_quantizations).toEqual({ DeepInfra: 'fp4' });
	});

	test('unpinned + no providers reported degrades to null/empty, not a guess', () => {
		const meta = buildMeta({ ...cli, quantizations: undefined }, manifest, 'p', new Date(), {
			...result,
			providers: undefined
		});
		expect(meta.quantization_requested).toBeNull();
		expect(meta.providers).toEqual([]);
		expect(meta.provider_quantizations).toEqual({});
	});
});

describe('formatDuration / formatWallClock', () => {
	test('sub-minute reads in seconds, longer in m/s', () => {
		expect(formatDuration(0)).toBe('0.0s');
		expect(formatDuration(12_340)).toBe('12.3s');
		expect(formatDuration(59_900)).toBe('59.9s');
		expect(formatDuration(64_000)).toBe('1m 04s');
		expect(formatDuration(3_600_000)).toBe('60m 00s');
	});

	test('the stderr line reports the total and breaks out the agent run', () => {
		expect(formatWallClock({ wall_clock_ms: 75_000, duration_ms: 64_000 })).toBe(
			'wall-clock 1m 15s total (1m 04s in the agent run)'
		);
	});
});

describe('buildMeta effort/temperature fields', () => {
	const manifest = { entryUrl: 'https://x.com/' } as BenchManifest;
	const result: RunResult = {
		status: 'scored',
		toolCalls: 1,
		submitAttempts: 1,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedPromptTokens: 0,
		cacheWriteTokens: 0,
		usages: []
	};
	const base: CliArgs = {
		taskDir: 'bench/tasks/x',
		model: 'm',
		maxToolCalls: 40,
		backend: 'openrouter',
		harness: 'single-pass'
	};

	test('records requested values and provider-default when unset (openrouter)', () => {
		const set = buildMeta(
			{ ...base, effort: 'high', temperature: 0.3 },
			manifest,
			'2026-07-11',
			new Date(),
			result,
			{ price: null, price_cached: null }
		);
		expect(set.effort).toBe('high');
		expect(set.temperature).toBe(0.3);
		expect(set.effort_default).toBe('provider-default');

		const unset = buildMeta(base, manifest, '2026-07-11', new Date(), result, {
			price: null,
			price_cached: null
		});
		expect(unset.effort).toBeNull();
		expect(unset.temperature).toBeNull();
		expect(unset.effort_default).toBe('provider-default');
	});

	test('wall_clock_ms spans process start, duration_ms only the agent run', () => {
		const invokedAt = new Date(Date.now() - 5_000);
		const startedAt = new Date(Date.now() - 2_000);
		const meta = buildMeta(base, manifest, '2026-07-11', startedAt, result, undefined, invokedAt);

		expect(meta.invoked_at).toBe(invokedAt.toISOString());
		expect(meta.started_at).toBe(startedAt.toISOString());
		// Setup time (invoked → started) is inside wall_clock_ms but outside duration_ms.
		expect(meta.wall_clock_ms).toBeGreaterThanOrEqual(5_000);
		expect(meta.duration_ms).toBeGreaterThanOrEqual(2_000);
		expect(meta.duration_ms).toBeLessThan(5_000);
		expect(meta.wall_clock_ms).toBeGreaterThan(meta.duration_ms);
	});

	test('wall_clock_ms falls back to the run start when no process start is passed', () => {
		const startedAt = new Date(Date.now() - 3_000);
		const meta = buildMeta(base, manifest, '2026-07-11', startedAt, result);
		expect(meta.invoked_at).toBe(startedAt.toISOString());
		expect(meta.wall_clock_ms).toBe(meta.duration_ms);
	});

	test('claude backend uses the claude-code-default note, temperature always null', () => {
		const meta = buildMeta(
			{ ...base, backend: 'claude', effort: 'xhigh' },
			manifest,
			'2026-07-11',
			new Date(),
			result
		);
		expect(meta.effort).toBe('xhigh');
		expect(meta.temperature).toBeNull();
		expect(meta.effort_default).toBe('claude-code-default');
	});
});
