// IO layer of the menu-source change gate: fetch one watch url and turn the
// response into a FetchOutcome (status + normalized hashes) for decide.ts.
//
// Fetch semantics per kind:
//   feed      plain fetch; body must parse as JSON or the row degenerates.
//   pdf       plain fetch; hash the pdftotext-extracted text. Without a
//             working pdftotext the bytes are hashed instead — the "bytes:"
//             prefix can never equal a "text:" baseline, so that environment
//             fails open into the agent path rather than lying.
//   html      plain fetch; hash the visible text of the raw response.
//   rendered  headless Chromium (the bench recorder's binary), post-JS
//             innerText — for pages whose raw HTML is an empty shell.
//
// Conditional GETs (If-None-Match / If-Modified-Since) run first for the
// non-rendered kinds: a 304 settles a row without normalization work.
// Bot walls are detected with the bench recorder's looksLikeBotWall — over
// TITLE + VISIBLE TEXT, never raw HTML, so anti-bot SDK script tags on
// perfectly readable pages don't false-positive.

import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { findChromium, looksLikeBotWall, settle } from '../bench/record';
import type { FetchOutcome, FetchStatus, WatchKind } from './decide';
import {
	contentHash,
	feedNormalize,
	htmlTitle,
	isDegenerate,
	signalHash,
	visibleText
} from './normalize';

const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const FETCH_TIMEOUT_MS = 30_000;

export interface FetchInput {
	url: string;
	kind: WatchKind;
	etag: string | null;
	last_modified: string | null;
}

function outcome(
	input: FetchInput,
	fields: Partial<FetchOutcome> & { fetch_status: FetchStatus }
): FetchOutcome {
	return {
		url: input.url,
		content_hash: null,
		signal_hash: null,
		etag: null,
		last_modified: null,
		...fields
	};
}

function statusFor(httpStatus: number): FetchStatus {
	if (httpStatus === 403 || httpStatus === 429 || httpStatus === 503) return 'blocked';
	return 'http_error';
}

/** Hash visible text the html/rendered way, sharing the bot-wall/degenerate guards. */
function textOutcome(
	input: FetchInput,
	httpStatus: number,
	title: string,
	text: string,
	validators: { etag: string | null; last_modified: string | null }
): FetchOutcome {
	if (looksLikeBotWall(httpStatus, title, text)) {
		return outcome(input, { fetch_status: 'blocked' });
	}
	if (isDegenerate(text)) return outcome(input, { fetch_status: 'degenerate' });
	return outcome(input, {
		fetch_status: 'ok',
		content_hash: contentHash('text', text),
		signal_hash: signalHash(text),
		...validators
	});
}

export async function pdfToText(bytes: Uint8Array): Promise<string | null> {
	try {
		const proc = Bun.spawn(['pdftotext', '-layout', '-', '-'], {
			stdin: bytes,
			stdout: 'pipe',
			stderr: 'ignore'
		});
		const text = await new Response(proc.stdout).text();
		const code = await proc.exited;
		return code === 0 ? text : null;
	} catch {
		return null;
	}
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

export function looksLikePdf(bytes: Uint8Array): boolean {
	return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Lazily-launched shared Chromium for 'rendered' rows. One browser serves a
 * whole check/baseline run; callers must close() it (a finally block) — a
 * leaked browser keeps the bun process alive.
 */
export class RenderedFetcher {
	private browser: Browser | undefined;
	private context: BrowserContext | undefined;

	private async ensure(): Promise<BrowserContext> {
		if (this.context) return this.context;
		this.browser = await chromium.launch({ executablePath: findChromium(), headless: true });
		this.context = await this.browser.newContext({ userAgent: USER_AGENT });
		return this.context;
	}

	/** Post-JS page text; throws when Chromium is unavailable (caller maps to http_error). */
	async fetch(url: string): Promise<{ status: number; title: string; text: string }> {
		const context = await this.ensure();
		const page = await context.newPage();
		try {
			const response = await page.goto(url, { timeout: FETCH_TIMEOUT_MS, waitUntil: 'load' });
			await settle(page, 1_500);
			const title = await page.title().catch(() => '');
			const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
			return { status: response?.status() ?? 0, title, text };
		} finally {
			await page.close().catch(() => {});
		}
	}

	async close(): Promise<void> {
		await this.context?.close().catch(() => {});
		await this.browser?.close().catch(() => {});
		this.context = undefined;
		this.browser = undefined;
	}
}

/**
 * Fetch + normalize + hash one watch url. Network/timeout errors and Chromium
 * launch failures come back as fetch_status 'http_error' — never thrown — so
 * one dead url cannot abort a whole check sweep.
 */
export async function fingerprintUrl(
	input: FetchInput,
	rendered: RenderedFetcher
): Promise<FetchOutcome> {
	if (input.kind === 'rendered') {
		let page: { status: number; title: string; text: string };
		try {
			page = await rendered.fetch(input.url);
		} catch {
			return outcome(input, { fetch_status: 'http_error' });
		}
		if (page.status >= 400 && !looksLikeBotWall(page.status, page.title, page.text)) {
			return outcome(input, { fetch_status: statusFor(page.status) });
		}
		// innerText is already text — only line/whitespace normalization applies.
		const text = normalizeTextLines(page.text);
		return textOutcome(input, page.status, page.title, text, { etag: null, last_modified: null });
	}

	const raw = await rawFetch(input.url, input);
	if (raw === null) return outcome(input, { fetch_status: 'http_error' });
	if (raw.notModified) {
		return outcome(input, {
			fetch_status: 'ok',
			not_modified: true,
			etag: input.etag,
			last_modified: input.last_modified
		});
	}
	if (raw.status < 200 || raw.status >= 300) {
		return outcome(input, { fetch_status: statusFor(raw.status) });
	}
	if (raw.bytes.byteLength === 0) return outcome(input, { fetch_status: 'http_error' });
	return outcomeFromBytes(input, raw);
}

export interface RawFetchResult {
	status: number;
	notModified: boolean;
	contentType: string | null;
	bytes: Uint8Array;
	etag: string | null;
	lastModified: string | null;
}

/** Plain conditional GET; null on network error/timeout (never throws). */
export async function rawFetch(
	url: string,
	validators?: { etag: string | null; last_modified: string | null }
): Promise<RawFetchResult | null> {
	let response: Response;
	try {
		const headers: Record<string, string> = { 'user-agent': USER_AGENT };
		if (validators?.etag) headers['if-none-match'] = validators.etag;
		if (validators?.last_modified) headers['if-modified-since'] = validators.last_modified;
		response = await fetch(url, {
			headers,
			redirect: 'follow',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
	} catch {
		return null;
	}
	const bytes =
		response.status === 304
			? new Uint8Array(0)
			: new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
	return {
		status: response.status,
		notModified: response.status === 304,
		contentType: response.headers.get('content-type'),
		bytes,
		etag: response.headers.get('etag'),
		lastModified: response.headers.get('last-modified')
	};
}

/** Normalize + hash an already-fetched 2xx body according to input.kind. */
export async function outcomeFromBytes(
	input: FetchInput,
	raw: RawFetchResult
): Promise<FetchOutcome> {
	const validators = { etag: raw.etag, last_modified: raw.lastModified };
	const bytes = raw.bytes;

	if (input.kind === 'feed') {
		const normalized = feedNormalize(new TextDecoder().decode(bytes));
		if (normalized === null) return outcome(input, { fetch_status: 'degenerate' });
		return outcome(input, {
			fetch_status: 'ok',
			content_hash: contentHash('feed', normalized),
			...validators
		});
	}

	if (input.kind === 'pdf') {
		if (!looksLikePdf(bytes)) return outcome(input, { fetch_status: 'degenerate' });
		const text = await pdfToText(bytes);
		return outcome(input, {
			fetch_status: 'ok',
			content_hash:
				text === null ? contentHash('bytes', bytes) : contentHash('text', normalizeTextLines(text)),
			...validators
		});
	}

	// kind 'html'
	const html = new TextDecoder().decode(bytes);
	return textOutcome(input, raw.status, htmlTitle(html), visibleText(html), validators);
}

/** Plain text (pdftotext output, innerText) → the line shape visibleText yields. */
export function normalizeTextLines(text: string): string {
	return text
		.split('\n')
		.map((line) => line.replace(/\s+/g, ' ').trim())
		.filter((line) => line.length > 0)
		.join('\n');
}

/** Content-type → watch kind for baseline classification. */
export function classifyKind(contentType: string | null, bytes: Uint8Array): WatchKind {
	const ct = (contentType ?? '').toLowerCase();
	if (ct.includes('json')) return 'feed';
	if (ct.includes('pdf') || looksLikePdf(bytes)) return 'pdf';
	return 'html';
}
