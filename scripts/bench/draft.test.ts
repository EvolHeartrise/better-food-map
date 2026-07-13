import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	buildReview,
	draftTask,
	formatReview,
	parseCli,
	stampDraft,
	type CliArgs,
	type Draft
} from './draft';
import { SnapshotStore } from './snapshot-store';
import type { ChatFn, ChatResponse, TranscriptEvent } from './run';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A temp task dir with a SnapshotStore under <task>/snapshot, cleaned up after. */
async function withTask(
	fn: (task: { dir: string; store: SnapshotStore }) => Promise<void>
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'bench-draft-'));
	try {
		await fn({ dir, store: new SnapshotStore(join(dir, 'snapshot')) });
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
		usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
	};
}

function scriptedChat(steps: ChatResponse[]): ChatFn {
	let i = 0;
	return async () => {
		const step = steps[i++];
		if (step === undefined) throw new Error('scriptedChat: no more steps');
		return step;
	};
}

/** Record a single HTML page into the store so its item names are in the corpus. */
function recordPage(store: SnapshotStore, url: string, html: string): void {
	store.put({ method: 'GET', url, status: 200, contentType: 'text/html', body: enc(html) });
}

const SUBMIT = {
	sources: ['https://x.com/menu'],
	items: [
		{ name: 'Samosa', description: null, tags: ['vegan'], optional_tags: [], price: 3.99 },
		{ name: 'Chai', description: null, tags: [], optional_tags: [], price: 2.5 }
	]
};

describe('parseCli --effort', () => {
	const base = ['task-dir', '--model', 'openai/gpt-5'];
	const ok = (argv: string[]): CliArgs => {
		const parsed = parseCli(argv);
		if ('error' in parsed) throw new Error(`unexpected parse error: ${parsed.error}`);
		return parsed;
	};

	test('accepts a valid OpenRouter effort level', () => {
		expect(ok([...base, '--effort', 'high']).effort).toBe('high');
		expect(ok([...base, '--effort', 'none']).effort).toBe('none');
		expect(ok([...base, '--effort', 'max']).effort).toBe('max');
	});

	test('rejects an unknown level (parse error, main() exits 2)', () => {
		const parsed = parseCli([...base, '--effort', 'ultra']);
		expect('error' in parsed && parsed.error).toContain('--effort must be one of');
	});

	test('rejects a missing level value', () => {
		const parsed = parseCli([...base, '--effort']);
		expect('error' in parsed && parsed.error).toBe('--effort requires a level');
	});

	test('absent --effort leaves effort undefined', () => {
		expect(ok(base).effort).toBeUndefined();
	});
});

describe('stampDraft', () => {
	test('stamps the given policy_version onto a candidate', () => {
		const draft = stampDraft(
			{ sources: ['https://x.com/menu'], items: SUBMIT.items },
			'2026-08-01'
		);
		expect(draft.policy_version).toBe('2026-08-01');
		expect(draft.items).toHaveLength(2);
	});
});

describe('draftTask', () => {
	test('scored run writes gold/draft.json stamped with the policy version', async () => {
		await withTask(async ({ dir, store }) => {
			recordPage(store, 'https://x.com/menu', '<h1>Samosa</h1><p>Chai</p>');
			const transcript: TranscriptEvent[] = [];
			const outcome = await draftTask({
				chat: scriptedChat([toolCallResponse('submit_menu', SUBMIT)]),
				store,
				taskDir: dir,
				entryUrl: 'https://x.com/',
				maxToolCalls: 40,
				policyVersion: 'draft',
				force: false,
				transcript
			});
			expect(outcome.status).toBe('written');
			const draftPath = join(dir, 'gold', 'draft.json');
			expect(existsSync(draftPath)).toBe(true);
			// NEVER writes gold/data.json
			expect(existsSync(join(dir, 'gold', 'data.json'))).toBe(false);
			const written = JSON.parse(readFileSync(draftPath, 'utf-8')) as Draft;
			expect(written.policy_version).toBe('draft');
			expect(written.items).toHaveLength(2);
			// transcript is written for debuggability
			expect(existsSync(join(dir, 'gold', 'draft-transcript.jsonl'))).toBe(true);
		});
	});

	test('refuses to clobber an existing draft unless --force', async () => {
		await withTask(async ({ dir, store }) => {
			recordPage(store, 'https://x.com/menu', '<h1>Samosa</h1><p>Chai</p>');
			mkdirSync(join(dir, 'gold'), { recursive: true });
			writeFileSync(join(dir, 'gold', 'draft.json'), '{"stale":true}');

			const refused = await draftTask({
				chat: scriptedChat([toolCallResponse('submit_menu', SUBMIT)]),
				store,
				taskDir: dir,
				entryUrl: 'https://x.com/',
				maxToolCalls: 40,
				policyVersion: 'draft',
				force: false,
				transcript: []
			});
			expect(refused.status).toBe('refused');
			// untouched
			expect(readFileSync(join(dir, 'gold', 'draft.json'), 'utf-8')).toBe('{"stale":true}');

			const forced = await draftTask({
				chat: scriptedChat([toolCallResponse('submit_menu', SUBMIT)]),
				store,
				taskDir: dir,
				entryUrl: 'https://x.com/',
				maxToolCalls: 40,
				policyVersion: 'draft',
				force: true,
				transcript: []
			});
			expect(forced.status).toBe('written');
			expect(JSON.parse(readFileSync(join(dir, 'gold', 'draft.json'), 'utf-8')).items).toHaveLength(
				2
			);
		});
	});

	test('failed run writes a transcript but no draft', async () => {
		await withTask(async ({ dir, store }) => {
			const plain: ChatResponse = {
				choices: [{ message: { role: 'assistant', content: 'thinking' } }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
			};
			const outcome = await draftTask({
				chat: scriptedChat([plain, plain]),
				store,
				taskDir: dir,
				entryUrl: 'https://x.com/',
				maxToolCalls: 40,
				policyVersion: 'draft',
				force: false,
				transcript: []
			});
			expect(outcome.status).toBe('failed');
			expect(existsSync(join(dir, 'gold', 'draft.json'))).toBe(false);
			expect(existsSync(join(dir, 'gold', 'draft-transcript.jsonl'))).toBe(true);
		});
	});
});

describe('buildReview / formatReview', () => {
	test('flags a zero-hit item name and counts tagged items', async () => {
		await withTask(async ({ store }) => {
			// corpus has Samosa but NOT the hallucinated item
			recordPage(store, 'https://x.com/menu', '<h1>Samosa</h1>');
			const draft: Draft = {
				policy_version: 'draft',
				sources: ['https://x.com/menu'],
				items: [
					{ name: 'Samosa', description: null, tags: ['vegan'], optional_tags: [], price: 3.99 },
					{
						name: 'Phantom Dish',
						description: null,
						tags: [],
						optional_tags: [],
						price: null,
						warning: 'label conflict'
					}
				]
			};
			const review = buildReview(draft, store, {
				status: 'scored',
				toolCalls: 1,
				submitAttempts: 1,
				promptTokens: 10,
				completionTokens: 4,
				totalTokens: 14
			});
			expect(review.itemCount).toBe(2);
			expect(review.itemsWithTags).toBe(1);
			expect(review.itemsWithWarnings).toBe(1);
			expect(review.lint.errors.join()).toContain('Phantom Dish');

			const text = formatReview('gold/draft.json', review);
			expect(text).toContain('REVIEW: gold/draft.json');
			expect(text).toContain('1 with dietary tags');
			expect(text).toContain('total 14');
			expect(text).toContain('Phantom Dish');
		});
	});
});
