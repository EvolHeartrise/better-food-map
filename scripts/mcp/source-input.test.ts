import { test, expect } from 'bun:test';
import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
import { sourceInputSchema } from './source-input';

test('a bare URL string folds to { url, label: null }', () => {
	expect(v.parse(sourceInputSchema, 'https://example.com/menu')).toEqual({
		url: 'https://example.com/menu',
		label: null
	});
});

test('the object form passes through unchanged', () => {
	expect(
		v.parse(sourceInputSchema, { url: 'https://example.com/menu', label: 'Official menu' })
	).toEqual({ url: 'https://example.com/menu', label: 'Official menu' });
	expect(v.parse(sourceInputSchema, { url: 'https://example.com/menu' })).toEqual({
		url: 'https://example.com/menu'
	});
});

test('non-URL strings and malformed objects are rejected', () => {
	expect(() => v.parse(sourceInputSchema, 'not a url')).toThrow();
	expect(() => v.parse(sourceInputSchema, { label: 'no url' })).toThrow();
	expect(() => v.parse(sourceInputSchema, { url: 'also not a url' })).toThrow();
});

test('arrays mix both forms (as the tool schemas accept them)', () => {
	const arr = v.parse(v.array(sourceInputSchema), [
		'https://a.example/menu',
		{ url: 'https://b.example/menu', label: 'PDF' }
	]);
	expect(arr).toEqual([
		{ url: 'https://a.example/menu', label: null },
		{ url: 'https://b.example/menu', label: 'PDF' }
	]);
});

test('converts to JSON Schema for the MCP inputSchema without throwing', () => {
	// db-mcp-server.ts advertises schemas via toJsonSchema(errorMode: 'ignore');
	// the union (with its transform) must survive that conversion.
	const json = toJsonSchema(v.object({ sources: v.array(sourceInputSchema) }), {
		errorMode: 'ignore'
	}) as { properties?: { sources?: { items?: { anyOf?: unknown[] } } } };
	expect(json.properties?.sources?.items?.anyOf?.length).toBe(2);
});
