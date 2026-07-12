import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { GoldSchema, type GoldMenu } from './lint';
import { scoreCandidate } from './score';
import { SnapshotStore } from './snapshot-store';
import {
	capText,
	extractHrefs,
	fetchPage,
	modelSlug,
	runAgent,
	stripTrailingJunk,
	validateSubmission,
	type ChatFn,
	type ChatResponse,
	type TranscriptEvent
} from './run';

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
