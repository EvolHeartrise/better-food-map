// Regression pin for the locale snap-back bug: the localize hook stamps the
// %lang% / %textdir% placeholders in app.html, and an EXTRA copy of a token
// (e.g. in an explanatory comment) once swallowed the replacement, shipping the
// literal placeholder in the real <html lang> attribute — the client locale
// strategy then failed to read it and every client-rendered message fell back
// to the base locale. The hook now uses replaceAll as a belt, and this test is
// the suspenders: each token must appear exactly once, inside the <html> tag.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');

test.each(['%lang%', '%textdir%'])('%s appears exactly once, in the <html> tag', (token) => {
	expect(html.split(token).length - 1).toBe(1);
	const htmlTag = html.slice(html.indexOf('<html'), html.indexOf('>', html.indexOf('<html')) + 1);
	expect(htmlTag).toContain(token);
});
