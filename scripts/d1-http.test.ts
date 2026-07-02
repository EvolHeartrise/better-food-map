/// <reference types="bun-types" />
// Exercises inlineParams/toSqlLiteral — the literal-inlining path behind the
// D1 REST client's atomic batch, which writes to the PRODUCTION database. The
// invariants that matter: a `?` counts as a placeholder ONLY outside opaque
// regions (single-quoted strings with '' escaping, double-quoted identifiers
// with "" escaping, line and block comments); the placeholder count must equal
// the bound-param count exactly (too few AND too many both throw, never a
// silent shift); and a substituted literal is spliced in without being
// re-scanned, so bound values containing `?` or quotes stay inert.

import { test, expect } from 'bun:test';
import { inlineParams, toSqlLiteral } from '../src/lib/server/d1-http';

test('inlines each placeholder in order, doubling embedded single quotes', () => {
	expect(inlineParams('INSERT INTO t (a, b, c) VALUES (?, ?, ?)', ["Bob's Burgers", 7, null])).toBe(
		"INSERT INTO t (a, b, c) VALUES ('Bob''s Burgers', 7, NULL)"
	);
});

test('a ? inside a single-quoted string literal is not a placeholder', () => {
	// The literal's ? must not consume the binding meant for `id`.
	expect(inlineParams("UPDATE t SET note = 'sold out?' WHERE id = ?", [3])).toBe(
		"UPDATE t SET note = 'sold out?' WHERE id = 3"
	);
	// '' is an escaped quote, not a close+reopen — the region spans the ?.
	expect(inlineParams("UPDATE t SET note = 'isn''t it?' WHERE id = ?", [3])).toBe(
		"UPDATE t SET note = 'isn''t it?' WHERE id = 3"
	);
});

test('a ? inside a double-quoted identifier is not a placeholder', () => {
	expect(inlineParams('SELECT "weird?col" FROM t WHERE id = ?', [5])).toBe(
		'SELECT "weird?col" FROM t WHERE id = 5'
	);
	// "" escaping keeps the identifier region open across the doubled quote.
	expect(inlineParams('SELECT "a""b?" FROM t WHERE id = ?', [5])).toBe(
		'SELECT "a""b?" FROM t WHERE id = 5'
	);
});

test('a ? inside a line or block comment is not a placeholder', () => {
	expect(inlineParams('SELECT ? -- really? are you sure?\nFROM t', [1])).toBe(
		'SELECT 1 -- really? are you sure?\nFROM t'
	);
	// A line comment ends at the newline; placeholders after it are live again.
	expect(inlineParams('SELECT ? -- why?\n, ? FROM t', [1, 2])).toBe('SELECT 1 -- why?\n, 2 FROM t');
	expect(inlineParams('SELECT /* block? comment? */ ? FROM t', [2])).toBe(
		'SELECT /* block? comment? */ 2 FROM t'
	);
});

test('too few params throws', () => {
	expect(() => inlineParams('SELECT * FROM t WHERE a = ? AND b = ?', [1])).toThrow(
		'Statement has 2 placeholder(s) but 1 param(s) were bound'
	);
});

test('too many params throws', () => {
	expect(() => inlineParams('SELECT * FROM t WHERE a = ?', [1, 2])).toThrow(
		'Statement has 1 placeholder(s) but 2 param(s) were bound'
	);
	// The old failure mode: a quoted ? used to absorb a param and pass silently.
	expect(() => inlineParams("SELECT 'sold out?' FROM t", [1])).toThrow(
		'Statement has 0 placeholder(s) but 1 param(s) were bound'
	);
});

test('toSqlLiteral renders each bound type', () => {
	expect(toSqlLiteral(null)).toBe('NULL');
	expect(toSqlLiteral(undefined)).toBe('NULL');
	expect(toSqlLiteral(42.5)).toBe('42.5');
	expect(toSqlLiteral(Number.NaN)).toBe('NULL');
	expect(toSqlLiteral(Infinity)).toBe('NULL');
	expect(toSqlLiteral(9007199254740993n)).toBe('9007199254740993');
	expect(toSqlLiteral(true)).toBe('1');
	expect(toSqlLiteral(false)).toBe('0');
});

test('a bound string VALUE containing ? is spliced in, never re-scanned', () => {
	// The ? inside the first inlined literal must not swallow the second param.
	expect(inlineParams('UPDATE t SET note = ? WHERE id = ?', ['why? who knows', 9])).toBe(
		"UPDATE t SET note = 'why? who knows' WHERE id = 9"
	);
});
