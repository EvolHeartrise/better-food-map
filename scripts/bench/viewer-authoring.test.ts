import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAuthoring, TaskContextCache } from './viewer-authoring';

function call(
	tasksDir: string,
	cache: TaskContextCache,
	path: string,
	init?: RequestInit
): Promise<Response | null> {
	const url = new URL(`http://127.0.0.1${path}`);
	return handleAuthoring(new Request(url, init), url, tasksDir, cache);
}

async function bodyOf(response: Response | null): Promise<Record<string, unknown>> {
	expect(response).not.toBeNull();
	return (await (response as Response).json()) as Record<string, unknown>;
}

function tempTasksDir(): string {
	return mkdtempSync(join(tmpdir(), 'bench-authoring-'));
}

describe('handleAuthoring routing', () => {
	test('returns null for paths outside /api/authoring/', async () => {
		const dir = tempTasksDir();
		try {
			const cache = new TaskContextCache(dir);
			expect(await call(dir, cache, '/api/runs')).toBeNull();
			expect(await call(dir, cache, '/api/overview')).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('status on an empty tasks root reports no tasks and full strata', async () => {
		const dir = tempTasksDir();
		try {
			const cache = new TaskContextCache(dir);
			const body = await bodyOf(await call(dir, cache, '/api/authoring/status'));
			expect(body.tasks).toEqual([]);
			expect((body.strata as string[]).length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('slug safety', () => {
	test('a traversal-shaped task param is rejected, never resolved', async () => {
		const dir = tempTasksDir();
		try {
			const cache = new TaskContextCache(dir);
			for (const slug of ['../secrets', '..%2Fsecrets', 'UPPER', 'a b', '.hidden']) {
				const response = await call(
					dir,
					cache,
					`/api/authoring/task?task=${encodeURIComponent(slug)}`
				);
				expect((response as Response).status).toBe(404);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('create + claim', () => {
	test('create scaffolds task.json; claim restamps the stratum', async () => {
		const dir = tempTasksDir();
		try {
			const cache = new TaskContextCache(dir);
			const created = await bodyOf(
				await call(dir, cache, '/api/authoring/create', {
					method: 'POST',
					body: JSON.stringify({
						slug: 'test-venue',
						entry_url: 'https://example.com',
						stratum: 'single-page'
					})
				})
			);
			expect(created.ok).toBe(true);
			const task = JSON.parse(readFileSync(join(dir, 'test-venue', 'task.json'), 'utf-8')) as {
				stratum: string;
			};
			expect(task.stratum).toBe('single-page');

			const claimed = await bodyOf(
				await call(dir, cache, '/api/authoring/claim', {
					method: 'POST',
					body: JSON.stringify({ slug: 'test-venue', stratum: 'pdf-menu' })
				})
			);
			expect(claimed.ok).toBe(true);
			const restamped = JSON.parse(readFileSync(join(dir, 'test-venue', 'task.json'), 'utf-8')) as {
				stratum: string;
			};
			expect(restamped.stratum).toBe('pdf-menu');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('create refuses a bad stratum and a bad slug', async () => {
		const dir = tempTasksDir();
		try {
			const cache = new TaskContextCache(dir);
			const badStratum = await call(dir, cache, '/api/authoring/create', {
				method: 'POST',
				body: JSON.stringify({ slug: 'ok-slug', entry_url: 'https://x.com', stratum: 'nope' })
			});
			expect((badStratum as Response).status).toBe(400);
			const badSlug = await call(dir, cache, '/api/authoring/create', {
				method: 'POST',
				body: JSON.stringify({ slug: 'Bad Slug', entry_url: 'https://x.com', stratum: 'pdf-menu' })
			});
			expect((badSlug as Response).status).toBe(400);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('save + promote guards', () => {
	test('save refuses when the target gold file does not exist', async () => {
		const dir = tempTasksDir();
		try {
			mkdirSync(join(dir, 'a-task'), { recursive: true });
			const cache = new TaskContextCache(dir);
			const response = await call(dir, cache, '/api/authoring/save', {
				method: 'POST',
				body: JSON.stringify({ task: 'a-task', file: 'data', items: [] })
			});
			expect((response as Response).status).toBe(409);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('save rejects items that violate the gold schema', async () => {
		const dir = tempTasksDir();
		try {
			mkdirSync(join(dir, 'a-task', 'gold'), { recursive: true });
			writeFileSync(
				join(dir, 'a-task', 'gold', 'data.json'),
				JSON.stringify({ policy_version: 'v', sources: ['https://x.com'], items: [] })
			);
			const cache = new TaskContextCache(dir);
			const response = await call(dir, cache, '/api/authoring/save', {
				method: 'POST',
				body: JSON.stringify({
					task: 'a-task',
					file: 'data',
					items: [{ name: 'X', description: null, tags: ['spicy'], optional_tags: [], price: null }]
				})
			});
			expect((response as Response).status).toBe(400);
			const original = JSON.parse(
				readFileSync(join(dir, 'a-task', 'gold', 'data.json'), 'utf-8')
			) as { items: unknown[] };
			expect(original.items).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('promote refuses without a draft', async () => {
		const dir = tempTasksDir();
		try {
			mkdirSync(join(dir, 'a-task', 'gold'), { recursive: true });
			const cache = new TaskContextCache(dir);
			const response = await call(dir, cache, '/api/authoring/promote', {
				method: 'POST',
				body: JSON.stringify({ task: 'a-task', policy_version: '2026-08-08' })
			});
			expect((response as Response).status).toBe(400);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('writes require POST', async () => {
		const dir = tempTasksDir();
		try {
			const cache = new TaskContextCache(dir);
			for (const path of [
				'/api/authoring/save',
				'/api/authoring/promote',
				'/api/authoring/create',
				'/api/authoring/claim'
			]) {
				const response = await call(dir, cache, path);
				expect((response as Response).status).toBe(405);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
