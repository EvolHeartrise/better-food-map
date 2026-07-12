/**
 * Bench snapshot replay server.
 *
 * Serves a recorded snapshot over localhost so agents (and humans) can browse
 * a venue's site exactly as it was captured. Anything not in the snapshot
 * 404s AND lands in the miss log — while authoring, browse the replay and the
 * miss log becomes the to-do list for the next record pass.
 *
 * URL scheme:
 *   /<path>                      → primary host (from manifest)
 *   /__origin__/<host>/<path>    → any other recorded host
 *   /__rendered__?url=<url>      → post-JS rendered DOM of a crawled page
 *   /__report__                  → JSON coverage report (hits / misses / never-requested)
 *
 * Usage:
 *   bun run bench:serve <task-dir> [--port 8787] [--rewrite]
 *
 * --rewrite: rewrites absolute URLs of recorded hosts inside text bodies to
 * point back at this server — useful for human browsing in a real browser.
 * Leave it off for agent evals to keep bodies byte-faithful.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	findEntry,
	isTextType,
	loadManifest,
	SnapshotStore,
	type SnapshotEntry
} from './snapshot-store';

export interface ResolvedTarget {
	host: string;
	pathAndQuery: string;
}

/** Map an incoming replay-server path to the original (host, path). */
export function resolveTarget(
	pathname: string,
	search: string,
	primaryHost: string
): ResolvedTarget | undefined {
	if (pathname.startsWith('/__origin__/')) {
		const rest = pathname.slice('/__origin__/'.length);
		const slash = rest.indexOf('/');
		const host = slash === -1 ? rest : rest.slice(0, slash);
		if (!host) return undefined;
		const path = slash === -1 ? '/' : rest.slice(slash);
		return { host: host.toLowerCase(), pathAndQuery: path + search };
	}
	return { host: primaryHost, pathAndQuery: pathname + search };
}

/** Candidate original URLs for a target (we don't know the scheme; https first). */
export function candidateUrls(target: ResolvedTarget): string[] {
	return [
		`https://${target.host}${target.pathAndQuery}`,
		`http://${target.host}${target.pathAndQuery}`
	];
}

/** Rewrite absolute references to recorded hosts so they route back through the replay server. */
export function rewriteBody(
	text: string,
	hosts: string[],
	primaryHost: string,
	base: string
): string {
	let out = text;
	for (const host of hosts) {
		const to = host === primaryHost ? base : `${base}/__origin__/${host}`;
		out = out
			.replaceAll(`https://${host}`, to)
			.replaceAll(`http://${host}`, to)
			.replaceAll(`//${host}/`, `${to}/`);
	}
	return out;
}

export function rewriteLocation(
	location: string,
	hosts: string[],
	primaryHost: string,
	base: string
): string {
	try {
		const u = new URL(location);
		if (!hosts.includes(u.host.toLowerCase())) return location;
		const prefix =
			u.host.toLowerCase() === primaryHost ? '' : `/__origin__/${u.host.toLowerCase()}`;
		return `${base}${prefix}${u.pathname}${u.search}`;
	} catch {
		return location; // relative — already routes through us
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let port = 8787;
	let rewrite = false;
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--port') port = Number(args[++i]);
		else if (args[i] === '--rewrite') rewrite = true;
		else positional.push(args[i]);
	}
	const taskDir = positional[0];
	if (!taskDir) {
		console.error('usage: bun run bench:serve <task-dir> [--port n] [--rewrite]');
		process.exit(1);
	}
	const manifest = loadManifest(taskDir);
	if (!manifest) {
		console.error(`no manifest.json in ${taskDir} — record a snapshot first`);
		process.exit(1);
	}
	const store = new SnapshotStore(join(taskDir, 'snapshot'));
	const hosts = store.hosts();
	const primaryHost = manifest.primaryHost;
	const base = `http://localhost:${port}`;
	const missLog = join(taskDir, 'serve-misses.jsonl');
	const hits = new Map<string, number>();
	const misses = new Map<string, number>();

	const respond = (entry: SnapshotEntry): Response => {
		let body: BodyInit | undefined = store.body(entry);
		const headers = new Headers();
		if (entry.contentType) headers.set('content-type', entry.contentType);
		if (entry.location) {
			headers.set(
				'location',
				rewrite ? rewriteLocation(entry.location, hosts, primaryHost, base) : entry.location
			);
		}
		if (rewrite && body && isTextType(entry.contentType)) {
			body = rewriteBody(new TextDecoder().decode(body as Uint8Array), hosts, primaryHost, base);
		}
		return new Response(body, { status: entry.status, headers });
	};

	Bun.serve({
		port,
		async fetch(req) {
			const u = new URL(req.url);

			if (u.pathname === '/__report__') {
				const requested = new Set(hits.keys());
				const neverRequested = store.index.entries
					.filter((e) => !requested.has(`${e.method} ${e.url}`))
					.map((e) => `${e.method} ${e.url}`);
				return Response.json({
					hits: Object.fromEntries(hits),
					misses: Object.fromEntries(misses),
					neverRequested
				});
			}

			if (u.pathname === '/__rendered__') {
				const target = u.searchParams.get('url');
				const entry = target ? findEntry(store.index, 'GET', target) : undefined;
				const html = entry && store.renderedHtml(entry);
				if (!html) return new Response('no rendered DOM for that url\n', { status: 404 });
				return new Response(html, { headers: { 'content-type': 'text/html' } });
			}

			const target = resolveTarget(u.pathname, u.search, primaryHost);
			if (!target) return new Response('bad __origin__ path\n', { status: 400 });
			const requestBody =
				req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();

			for (const candidate of candidateUrls(target)) {
				const entry = findEntry(store.index, req.method, candidate, requestBody || undefined);
				if (entry) {
					hits.set(
						`${entry.method} ${entry.url}`,
						(hits.get(`${entry.method} ${entry.url}`) ?? 0) + 1
					);
					return respond(entry);
				}
			}

			const missKey = `${req.method} https://${target.host}${target.pathAndQuery}`;
			misses.set(missKey, (misses.get(missKey) ?? 0) + 1);
			appendFileSync(
				missLog,
				JSON.stringify({
					at: new Date().toISOString(),
					method: req.method,
					url: missKey.split(' ')[1],
					requestBody
				}) + '\n'
			);
			return new Response(`not in snapshot: ${missKey}\n`, { status: 404 });
		}
	});

	console.error(
		`replaying ${taskDir} (${store.index.entries.length} responses, hosts: ${hosts.join(', ')})`
	);
	console.error(`  ${base}/  →  ${primaryHost}${rewrite ? '   [rewrite mode]' : ''}`);
	console.error(`  coverage: ${base}/__report__   misses appended to ${missLog}`);
}
