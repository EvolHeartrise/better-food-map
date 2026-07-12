import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A recorded HTTP exchange. One entry per (method, url, requestBody) triple;
 * re-recording the same triple replaces the entry so snapshots stay merge-safe.
 */
export interface SnapshotEntry {
	method: string;
	url: string;
	/** POST/GraphQL request body, when present — part of the entry's identity. */
	requestBody?: string;
	status: number;
	contentType: string | null;
	/** Location header for 3xx responses. */
	location?: string;
	/** Body file name under snapshot/bodies/, absent for bodyless responses. */
	file?: string;
	size: number;
	recordedAt: string;
	/** Rendered-DOM file under snapshot/rendered/, only on navigated pages. */
	rendered?: string;
}

export interface SnapshotIndex {
	entries: SnapshotEntry[];
}

/** Canonical form used for matching: no fragment, no default port, lowercase host. */
export function normalizeUrl(raw: string): string {
	const u = new URL(raw);
	u.hash = '';
	u.hostname = u.hostname.toLowerCase();
	if (
		(u.protocol === 'https:' && u.port === '443') ||
		(u.protocol === 'http:' && u.port === '80')
	) {
		u.port = '';
	}
	return u.href;
}

export function hashKey(...parts: string[]): string {
	return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

const EXT_BY_TYPE: Record<string, string> = {
	'text/html': 'html',
	'application/json': 'json',
	'application/pdf': 'pdf',
	'text/css': 'css',
	'text/javascript': 'js',
	'application/javascript': 'js',
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/svg+xml': 'svg',
	'text/plain': 'txt',
	'application/xml': 'xml',
	'text/xml': 'xml'
};

export function extFor(contentType: string | null): string {
	if (!contentType) return 'bin';
	const bare = contentType.split(';')[0].trim().toLowerCase();
	return EXT_BY_TYPE[bare] ?? (bare.endsWith('+json') ? 'json' : 'bin');
}

export function isTextType(contentType: string | null): boolean {
	if (!contentType) return false;
	const bare = contentType.split(';')[0].trim().toLowerCase();
	return (
		bare.startsWith('text/') ||
		bare === 'application/json' ||
		bare === 'application/javascript' ||
		bare.endsWith('+json') ||
		bare.endsWith('+xml')
	);
}

/**
 * Find the recorded entry for a request. Exact (method, url, body) wins;
 * a (method, url) match is the fallback so e.g. a POST with a cache-busting
 * timestamp in its body still replays.
 */
export function findEntry(
	index: SnapshotIndex,
	method: string,
	url: string,
	requestBody?: string
): SnapshotEntry | undefined {
	let norm: string;
	try {
		norm = normalizeUrl(url);
	} catch {
		return undefined;
	}
	const m = method.toUpperCase();
	const candidates = index.entries.filter((e) => e.method === m && e.url === norm);
	if (candidates.length === 0) return undefined;
	if (requestBody !== undefined) {
		const exact = candidates.find((e) => e.requestBody === requestBody);
		if (exact) return exact;
	}
	return candidates.find((e) => e.requestBody === undefined) ?? candidates[0];
}

/** Disk layout: <dir>/index.json, <dir>/bodies/<hash>.<ext>, <dir>/rendered/<hash>.html */
export class SnapshotStore {
	readonly dir: string;
	index: SnapshotIndex;

	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(join(dir, 'bodies'), { recursive: true });
		mkdirSync(join(dir, 'rendered'), { recursive: true });
		try {
			this.index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8'));
		} catch {
			this.index = { entries: [] };
		}
	}

	put(input: {
		method: string;
		url: string;
		requestBody?: string;
		status: number;
		contentType: string | null;
		location?: string;
		body?: Uint8Array;
	}): SnapshotEntry {
		const url = normalizeUrl(input.url);
		const method = input.method.toUpperCase();
		const entry: SnapshotEntry = {
			method,
			url,
			requestBody: input.requestBody,
			status: input.status,
			contentType: input.contentType,
			location: input.location,
			size: input.body?.byteLength ?? 0,
			recordedAt: new Date().toISOString()
		};
		if (input.body && input.body.byteLength > 0) {
			entry.file = `${hashKey(method, url, input.requestBody ?? '')}.${extFor(input.contentType)}`;
			writeFileSync(join(this.dir, 'bodies', entry.file), input.body);
		}
		const i = this.index.entries.findIndex(
			(e) => e.method === method && e.url === url && e.requestBody === input.requestBody
		);
		if (i >= 0) {
			// keep an existing rendered-DOM pointer across re-records
			entry.rendered = this.index.entries[i].rendered;
			this.index.entries[i] = entry;
		} else {
			this.index.entries.push(entry);
		}
		return entry;
	}

	putRendered(url: string, html: string): void {
		const norm = normalizeUrl(url);
		const file = `${hashKey('GET', norm)}.html`;
		writeFileSync(join(this.dir, 'rendered', file), html);
		const entry = this.index.entries.find(
			(e) => e.method === 'GET' && e.url === norm && e.requestBody === undefined
		);
		if (entry) entry.rendered = file;
		else {
			this.index.entries.push({
				method: 'GET',
				url: norm,
				status: 200,
				contentType: 'text/html',
				size: 0,
				recordedAt: new Date().toISOString(),
				rendered: file
			});
		}
	}

	body(entry: SnapshotEntry): Uint8Array | undefined {
		if (!entry.file) return undefined;
		return readFileSync(join(this.dir, 'bodies', entry.file));
	}

	renderedHtml(entry: SnapshotEntry): string | undefined {
		if (!entry.rendered) return undefined;
		return readFileSync(join(this.dir, 'rendered', entry.rendered), 'utf-8');
	}

	hosts(): string[] {
		return [...new Set(this.index.entries.map((e) => new URL(e.url).host))];
	}

	save(): void {
		this.index.entries.sort(
			(a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method)
		);
		writeFileSync(join(this.dir, 'index.json'), JSON.stringify(this.index, null, '\t'));
	}
}

export interface BenchManifest {
	entryUrl: string;
	primaryHost: string;
	createdAt: string;
	lastRecordedAt: string;
	pages: { url: string; status: number; title: string; depth: number }[];
	warnings: string[];
	counts: { pages: number; responses: number; hosts: number };
}

export function loadManifest(taskDir: string): BenchManifest | undefined {
	try {
		return JSON.parse(readFileSync(join(taskDir, 'manifest.json'), 'utf-8'));
	} catch {
		return undefined;
	}
}

export function saveManifest(taskDir: string, manifest: BenchManifest): void {
	writeFileSync(join(taskDir, 'manifest.json'), JSON.stringify(manifest, null, '\t'));
}
