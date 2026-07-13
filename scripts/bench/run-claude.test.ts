import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseCli, requiresOpenRouterKey, type TranscriptEvent } from './run';
import {
	fetchPageToolResult,
	mapSdkMessage,
	newRunState,
	runClaudeAgent,
	submitToolResult,
	type QueryFn
} from './run-claude';
import { SnapshotStore } from './snapshot-store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function withStore(fn: (store: SnapshotStore) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'bench-claude-'));
	try {
		fn(new SnapshotStore(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function withStoreAsync(fn: (store: SnapshotStore) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'bench-claude-'));
	try {
		await fn(new SnapshotStore(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Parse the single text block of an MCP tool result back into a value. */
function toolResultValue(result: { content: { type: string; text?: string }[] }): unknown {
	const block = result.content[0];
	return JSON.parse(block.text ?? '');
}

// Cast a plain object to SDKMessage for the pure mapping tests — the harness
// only reads a handful of fields, so a full typed SDK message is unnecessary.
function sdkMsg(obj: unknown): SDKMessage {
	return obj as SDKMessage;
}

describe('fetchPageToolResult', () => {
	test('returns the fetchPage output wrapped as an MCP text result', () => {
		withStore((store) => {
			store.put({
				method: 'GET',
				url: 'https://x.com/menu',
				status: 200,
				contentType: 'text/html',
				body: enc('<h1>Samosa $3.99</h1><a href="/drinks">Drinks</a>')
			});
			const result = fetchPageToolResult(store, 'https://x.com/menu');
			const value = toolResultValue(result) as { status: number; text: string; links: string[] };
			expect(value.status).toBe(200);
			expect(value.text).toContain('Samosa');
			expect(value.links).toEqual(['https://x.com/drinks']);
		});
	});

	test('a URL not in the snapshot returns a 404 note', () => {
		withStore((store) => {
			const value = toolResultValue(fetchPageToolResult(store, 'https://x.com/nope'));
			expect(value).toEqual({ status: 404, note: 'not in snapshot' });
		});
	});
});

describe('submitToolResult', () => {
	test('round-trips validation failure → issues → success with sanitation applied', () => {
		const state = newRunState();

		// First attempt: an invalid tag → issues handed back, not done.
		const bad = submitToolResult(state, {
			sources: ['https://x.com/menu'],
			items: [
				{ name: 'Samosa', description: null, tags: ['bogus'], optional_tags: [], price: 3.99 }
			]
		});
		expect(bad.isError).toBe(true);
		const badValue = toolResultValue(bad) as { ok: boolean; issues: string[] };
		expect(badValue.ok).toBe(false);
		expect(badValue.issues.length).toBeGreaterThan(0);
		expect(state.done).toBe(false);
		expect(state.submitAttempts).toBe(1);
		expect(state.candidate).toBeUndefined();

		// Second attempt: valid, with trailing list-delimiter junk on the description.
		const rawDescription = "Stuffed with potatoes, peas and paneer.', ";
		const good = submitToolResult(state, {
			sources: ['https://x.com/menu'],
			items: [
				{
					name: 'Samosa',
					description: rawDescription,
					tags: ['vegan'],
					optional_tags: [],
					price: 3.99
				}
			]
		});
		expect(good.isError).toBeUndefined();
		expect(toolResultValue(good)).toEqual({ ok: true });
		expect(state.done).toBe(true);
		expect(state.submitAttempts).toBe(2);
		// sanitation stripped the trailing quote/comma/space down to the period.
		expect(state.candidate?.items[0].description).toBe('Stuffed with potatoes, peas and paneer.');
	});
});

describe('mapSdkMessage', () => {
	test('assistant text + tool_use → response and tool_call (mcp prefix stripped)', () => {
		const events = mapSdkMessage(
			sdkMsg({
				type: 'assistant',
				message: {
					content: [
						{ type: 'text', text: 'Fetching the menu.' },
						{
							type: 'tool_use',
							id: 'tu_1',
							name: 'mcp__bench__fetch_page',
							input: { url: 'https://x.com/menu' }
						}
					],
					usage: { input_tokens: 10, output_tokens: 4 }
				}
			})
		);
		const response = events.find((e) => e.type === 'response');
		expect(response?.message).toEqual({ role: 'assistant', content: 'Fetching the menu.' });
		const call = events.find((e) => e.type === 'tool_call');
		expect(call?.name).toBe('fetch_page');
		expect(call?.id).toBe('tu_1');
		expect(call?.arguments).toEqual({ url: 'https://x.com/menu' });
	});

	test('user tool_result → tool_result event', () => {
		const events = mapSdkMessage(
			sdkMsg({
				type: 'user',
				message: {
					content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"status":200}' }]
				}
			})
		);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('tool_result');
		expect(events[0].id).toBe('tu_1');
		expect(events[0].result).toBe('{"status":200}');
	});

	test('result → note event carrying usage and cost', () => {
		const events = mapSdkMessage(
			sdkMsg({
				type: 'result',
				subtype: 'success',
				usage: { input_tokens: 100, output_tokens: 20 },
				total_cost_usd: 0.0123
			})
		);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('note');
		expect(events[0].total_cost_usd).toBe(0.0123);
	});

	test('non-conversational message types map to nothing', () => {
		expect(mapSdkMessage(sdkMsg({ type: 'system', subtype: 'init' }))).toEqual([]);
	});
});

describe('runClaudeAgent (injected queryFn)', () => {
	/**
	 * A fake SDK stream that drives the loop's OWN tool handlers (via the `tools`
	 * seam) exactly as the real CLI would: emit an assistant tool_use, invoke the
	 * bound handler, echo the tool_result as a user message. This is how a
	 * successful submit flips the loop's internal `state.done`.
	 */
	function scriptedQuery(steps: { call: 'fetchPage' | 'submit'; input: unknown }[]): QueryFn {
		return async function* ({ tools }) {
			let n = 0;
			for (const step of steps) {
				const id = `tu_${n++}`;
				const name =
					step.call === 'fetchPage' ? 'mcp__bench__fetch_page' : 'mcp__bench__submit_menu';
				yield sdkMsg({
					type: 'assistant',
					message: {
						content: [{ type: 'tool_use', id, name, input: step.input }],
						usage: { input_tokens: 5, output_tokens: 3 }
					}
				});
				const result =
					step.call === 'fetchPage'
						? tools.fetchPage((step.input as { url: string }).url)
						: tools.submit(step.input);
				yield sdkMsg({
					type: 'user',
					message: {
						content: [{ type: 'tool_result', tool_use_id: id, content: result.content[0].text }]
					}
				});
			}
		};
	}

	test('a successful submit yields a scored RunResult and a uniform transcript', async () => {
		await withStoreAsync(async (store) => {
			store.put({
				method: 'GET',
				url: 'https://x.com/menu',
				status: 200,
				contentType: 'text/html',
				body: enc('<h1>Samosa $3.99</h1>')
			});
			const transcript: TranscriptEvent[] = [];
			const submission = {
				sources: ['https://x.com/menu'],
				items: [
					{ name: 'Samosa', description: null, tags: ['vegan'], optional_tags: [], price: 3.99 }
				]
			};
			const result = await runClaudeAgent({
				model: 'claude-test',
				store,
				entryUrl: 'https://x.com/',
				maxToolCalls: 40,
				transcript,
				queryFn: scriptedQuery([
					{ call: 'fetchPage', input: { url: 'https://x.com/menu' } },
					{ call: 'submit', input: submission }
				])
			});
			expect(result.status).toBe('scored');
			expect(result.submitAttempts).toBe(1);
			expect(result.candidate?.items).toHaveLength(1);
			expect(result.toolCalls).toBe(2);
			// usage accumulated from the two assistant messages (5 in / 3 out each).
			expect(result.promptTokens).toBe(10);
			expect(result.completionTokens).toBe(6);

			const kinds = new Set(transcript.map((e) => e.type));
			expect(kinds.has('response')).toBe(true);
			expect(kinds.has('tool_call')).toBe(true);
			expect(kinds.has('tool_result')).toBe(true);
		});
	});

	test('a run that never submits fails with a reason', async () => {
		await withStoreAsync(async (store) => {
			const transcript: TranscriptEvent[] = [];
			const result = await runClaudeAgent({
				model: 'claude-test',
				store,
				entryUrl: 'https://x.com/',
				maxToolCalls: 40,
				transcript,
				queryFn: async function* () {
					yield sdkMsg({
						type: 'result',
						subtype: 'error_max_turns',
						usage: { input_tokens: 3, output_tokens: 1 },
						total_cost_usd: 0.001
					});
				}
			});
			expect(result.status).toBe('failed');
			expect(result.failureReason).toContain('error_max_turns');
			expect(result.totalCostUsd).toBe(0.001);
		});
	});
});

describe('CLI backend parsing', () => {
	test('defaults to the openrouter backend', () => {
		const cli = parseCli(['bench/tasks/x', '--model', 'anthropic/claude']);
		if ('error' in cli) throw new Error(cli.error);
		expect(cli.backend).toBe('openrouter');
		expect(requiresOpenRouterKey(cli.backend)).toBe(true);
	});

	test('accepts the claude backend, which does not require an OpenRouter key', () => {
		const cli = parseCli(['bench/tasks/x', '--model', 'claude-sonnet-5', '--backend', 'claude']);
		if ('error' in cli) throw new Error(cli.error);
		expect(cli.backend).toBe('claude');
		expect(requiresOpenRouterKey(cli.backend)).toBe(false);
	});

	test('rejects an unknown backend', () => {
		const cli = parseCli(['bench/tasks/x', '--model', 'm', '--backend', 'bogus']);
		expect('error' in cli).toBe(true);
		if ('error' in cli) expect(cli.error).toContain('backend');
	});
});
