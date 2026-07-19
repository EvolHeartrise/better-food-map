/// <reference types="bun-types" />
import { test, expect } from 'bun:test';
import {
	canonicalJson,
	contentHash,
	decodeEntities,
	feedNormalize,
	htmlTitle,
	isDegenerate,
	MIN_PRICE_LINES,
	priceSignal,
	signalHash,
	stripVolatile,
	visibleText
} from './normalize';

// ---------------------------------------------------------------------------
// feed normalization
// ---------------------------------------------------------------------------

test('feedNormalize: identical content with reordered keys hashes identically', () => {
	const a = feedNormalize('{"menu":{"name":"Burger","price":9.99}}');
	const b = feedNormalize('{"menu":{"price":9.99,"name":"Burger"}}');
	expect(a).toBe(b as string);
});

test('feedNormalize: volatile keys and datetime values do not affect the result', () => {
	const base = feedNormalize('{"items":[{"name":"Pho","price":15}]}');
	const noisy = feedNormalize(
		JSON.stringify({
			items: [{ name: 'Pho', price: 15 }],
			timestamp: 1789000000000,
			sessionToken: 'abc123',
			request_id: 'r-42',
			generatedAt: '2026-07-18T09:00:00Z',
			cacheKey: 'k9'
		})
	);
	expect(noisy).toBe(base as string);
});

test('feedNormalize: a real price change changes the result', () => {
	const a = feedNormalize('{"items":[{"name":"Pho","price":15}]}');
	const b = feedNormalize('{"items":[{"name":"Pho","price":16}]}');
	expect(a).not.toBe(b);
});

test('feedNormalize: non-JSON body returns null', () => {
	expect(feedNormalize('<html>oops</html>')).toBeNull();
});

test('stripVolatile: bare dates survive, datetimes are dropped', () => {
	const out = stripVolatile({
		promo_ends: '2026-08-01',
		served_at: '2026-07-18T12:00:00Z'
	}) as Record<string, unknown>;
	expect(out.promo_ends).toBe('2026-08-01');
	expect('served_at' in out).toBe(false);
});

test('canonicalJson: arrays keep order (feed order is content)', () => {
	expect(canonicalJson([2, 1])).toBe('[2,1]');
	expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
});

// ---------------------------------------------------------------------------
// html visible text
// ---------------------------------------------------------------------------

test('visibleText: scripts, styles, comments and attributes vanish; text and lines stay', () => {
	const html = `<html><head><title>Cafe</title><script>var nonce="x9";</script></head>
		<body class="theme-abc123"><style>.a{color:red}</style>
		<!-- build 20260718 --><ul><li>Latte &amp; Scone  $8.50</li><li>Espresso $3.25</li></ul></body></html>`;
	const text = visibleText(html);
	expect(text).toContain('Latte & Scone $8.50');
	expect(text).toContain('Espresso $3.25');
	expect(text).not.toContain('nonce');
	expect(text).not.toContain('color:red');
	expect(text).not.toContain('theme-abc123');
	expect(text).not.toContain('build 20260718');
	// block elements become separate lines — priceSignal depends on this
	expect(text.split('\n')).toContain('Espresso $3.25');
});

test('visibleText: identical page with a rotated script nonce hashes identically', () => {
	const page = (nonce: string) =>
		`<body><script nonce="${nonce}">track()</script><p>Pad Thai 16.95</p><p>Spring Rolls 7.00</p><p>Mango Sticky Rice 9.50</p></body>`;
	expect(contentHash('text', visibleText(page('aaa')))).toBe(
		contentHash('text', visibleText(page('bbb')))
	);
});

test('htmlTitle: extracts and decodes the title', () => {
	expect(htmlTitle('<head><title>Fish &amp; Chips</title></head>')).toBe('Fish & Chips');
	expect(htmlTitle('<body>no title</body>')).toBe('');
});

test('decodeEntities: numeric and named forms', () => {
	expect(decodeEntities('caf&#233; &amp; bar &#x2013; open')).toBe('café & bar – open');
});

// ---------------------------------------------------------------------------
// price signal
// ---------------------------------------------------------------------------

test('priceSignal: ignores banner churn, catches a price change', () => {
	const menu = ['Pad Thai 16.95', 'Green Curry $18.00', 'Mango Sticky Rice 9.50'];
	const before = priceSignal(['Open until 10pm tonight!', ...menu].join('\n'));
	const after = priceSignal(['Holiday hours this week', ...menu].join('\n'));
	expect(before).toBe(after as string);
	const repriced = priceSignal(
		['Holiday hours this week', 'Pad Thai 17.95', ...menu.slice(1)].join('\n')
	);
	expect(repriced).not.toBe(before);
});

test('priceSignal: order-insensitive across section reshuffles', () => {
	const lines = ['Latte $4.50', 'Mocha $5.25', 'Drip $3.00'];
	expect(priceSignal(lines.join('\n'))).toBe(priceSignal(lines.toReversed().join('\n')) as string);
});

test(`priceSignal: fewer than ${MIN_PRICE_LINES} price lines is no signal`, () => {
	expect(priceSignal('One price $9.99\nand text\nmore text')).toBeNull();
	expect(signalHash('One price $9.99')).toBeNull();
});

test('priceSignal: dates and version strings are not prices', () => {
	const text = 'Updated 18.07.2026\nEst. 1995\nv2.10.3 release\nSince 2020';
	expect(priceSignal(text)).toBeNull();
});

// ---------------------------------------------------------------------------
// degenerate + hash prefixes
// ---------------------------------------------------------------------------

test('isDegenerate: thin pages are degenerate, real menus are not', () => {
	expect(isDegenerate('Access denied')).toBe(true);
	const menu = Array.from({ length: 30 }, (_, i) => `Dish number ${i} with sauce $${i}.99`).join(
		'\n'
	);
	expect(isDegenerate(menu)).toBe(false);
});

test('contentHash: different pipelines can never compare equal', () => {
	const same = 'identical bytes';
	expect(contentHash('text', same)).not.toBe(contentHash('feed', same));
	expect(contentHash('text', same)).not.toBe(contentHash('bytes', same));
	expect(contentHash('text', same)).toBe(contentHash('text', same));
});
