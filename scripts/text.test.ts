import { test, expect } from 'bun:test';
import { decodeHtmlEntities } from '../src/lib/text';

test('decodes common named entities', () => {
	expect(decodeHtmlEntities('Bacon &amp; Egg English Muffin')).toBe('Bacon & Egg English Muffin');
	expect(decodeHtmlEntities('Mac &amp; Cheese &amp; Peas')).toBe('Mac & Cheese & Peas');
	expect(decodeHtmlEntities('&quot;Famous&quot; Fries')).toBe('"Famous" Fries');
	expect(decodeHtmlEntities('Ben &amp; Jerry&apos;s')).toBe("Ben & Jerry's");
	expect(decodeHtmlEntities('Fish&nbsp;Tacos')).toBe('Fish Tacos');
	expect(decodeHtmlEntities('Caf&eacute; au lait')).toBe('Café au lait');
	expect(decodeHtmlEntities('&frac12; Chicken')).toBe('½ Chicken');
});

test('decodes numeric character references (decimal and hex)', () => {
	expect(decodeHtmlEntities('Tom&#39;s Diner')).toBe("Tom's Diner");
	expect(decodeHtmlEntities('Caf&#233;')).toBe('Café');
	expect(decodeHtmlEntities('Caf&#xE9;')).toBe('Café');
	expect(decodeHtmlEntities('Caf&#Xe9;')).toBe('Café');
});

test('leaves plain ampersands and non-entities untouched', () => {
	expect(decodeHtmlEntities('Fish & Chips')).toBe('Fish & Chips');
	expect(decodeHtmlEntities('Soup & Salad; add bread')).toBe('Soup & Salad; add bread');
	expect(decodeHtmlEntities('AT&T Plaza')).toBe('AT&T Plaza');
	expect(decodeHtmlEntities('No entities here')).toBe('No entities here');
	expect(decodeHtmlEntities('')).toBe('');
});

test('decodes HTML5 uppercase legacy aliases', () => {
	expect(decodeHtmlEntities('Bacon &AMP; Egg')).toBe('Bacon & Egg');
	expect(decodeHtmlEntities('&LT;special&GT;')).toBe('<special>');
	expect(decodeHtmlEntities('&QUOT;Famous&QUOT; Fries')).toBe('"Famous" Fries');
	expect(decodeHtmlEntities('Big Mac&TRADE;')).toBe('Big Mac™');
	expect(decodeHtmlEntities('Coca-Cola&REG;')).toBe('Coca-Cola®');
	expect(decodeHtmlEntities('&COPY; 2026')).toBe('© 2026');
});

test('mixed-case forms are not valid HTML5 and pass through unchanged', () => {
	expect(decodeHtmlEntities('Fish &Amp; Chips')).toBe('Fish &Amp; Chips');
	expect(decodeHtmlEntities('&Quot;Famous&Quot;')).toBe('&Quot;Famous&Quot;');
	expect(decodeHtmlEntities('&Trade;')).toBe('&Trade;');
	expect(decodeHtmlEntities('&NBSP;')).toBe('&NBSP;');
});

test('unknown named references pass through unchanged', () => {
	expect(decodeHtmlEntities('&bogusref; Salad')).toBe('&bogusref; Salad');
	expect(decodeHtmlEntities('salt&pepper; mix')).toBe('salt&pepper; mix');
});

test('double-encoded text decodes exactly one level per pass', () => {
	expect(decodeHtmlEntities('Fish &amp;amp; Chips')).toBe('Fish &amp; Chips');
	expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
});

test('out-of-range and surrogate numeric references pass through', () => {
	expect(decodeHtmlEntities('&#0;x')).toBe('&#0;x');
	expect(decodeHtmlEntities('&#1114112;x')).toBe('&#1114112;x');
	expect(decodeHtmlEntities('&#xD800;x')).toBe('&#xD800;x');
});
