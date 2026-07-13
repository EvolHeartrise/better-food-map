import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	buildStatus,
	claimTask,
	createTask,
	formatStatus,
	isValidSlug,
	isValidStratum,
	STRATA,
	type TaskJson
} from './new';

function withRoot(fn: (root: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'bench-new-'));
	try {
		fn(join(dir, 'tasks'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('validation', () => {
	test('slug must be kebab-case', () => {
		expect(isValidSlug('meet-on-main')).toBe(true);
		expect(isValidSlug('venue1')).toBe(true);
		expect(isValidSlug('Meet_On_Main')).toBe(false);
		expect(isValidSlug('-lead')).toBe(false);
		expect(isValidSlug('trail-')).toBe(false);
		expect(isValidSlug('')).toBe(false);
	});
	test('stratum must be canonical', () => {
		expect(isValidStratum('single-page')).toBe(true);
		expect(isValidStratum('made-up')).toBe(false);
		expect(STRATA).toContain('bot-walled');
	});
});

describe('createTask', () => {
	test('writes a task.json with the four fields and refuses a re-create', () => {
		withRoot((root) => {
			const r = createTask({
				tasksRoot: root,
				slug: 'namdhari',
				entryUrl: 'https://www.namdharirestaurant.com/',
				stratum: 'single-page'
			});
			expect(r.ok).toBe(true);
			if (!r.ok) throw new Error('expected ok');
			const task = JSON.parse(readFileSync(join(r.taskDir, 'task.json'), 'utf-8')) as TaskJson;
			expect(task.slug).toBe('namdhari');
			expect(task.entry_url).toBe('https://www.namdharirestaurant.com/');
			expect(task.stratum).toBe('single-page');
			expect(typeof task.created_at).toBe('string');

			const again = createTask({
				tasksRoot: root,
				slug: 'namdhari',
				entryUrl: 'https://www.namdharirestaurant.com/',
				stratum: 'single-page'
			});
			expect(again.ok).toBe(false);
			if (again.ok) throw new Error('expected refusal');
			expect(again.error).toContain('already exists');
		});
	});

	test('rejects a bad slug, bad URL, and bad stratum', () => {
		withRoot((root) => {
			expect(
				createTask({
					tasksRoot: root,
					slug: 'Bad Slug',
					entryUrl: 'https://x.com',
					stratum: 'single-page'
				}).ok
			).toBe(false);
			expect(
				createTask({ tasksRoot: root, slug: 'ok', entryUrl: 'not-a-url', stratum: 'single-page' })
					.ok
			).toBe(false);
			expect(
				createTask({ tasksRoot: root, slug: 'ok', entryUrl: 'https://x.com', stratum: 'nope' }).ok
			).toBe(false);
		});
	});
});

describe('claimTask', () => {
	test('writes task.json for an existing dir, errors on a missing one', () => {
		withRoot((root) => {
			const taskDir = join(root, 'legacy');
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(
				join(taskDir, 'manifest.json'),
				JSON.stringify({ entryUrl: 'https://legacy.com/' })
			);
			const r = claimTask({ tasksRoot: root, slug: 'legacy', stratum: 'multi-page' });
			expect(r.ok).toBe(true);
			const task = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf-8')) as TaskJson;
			expect(task.stratum).toBe('multi-page');
			// entry_url is recovered from the manifest
			expect(task.entry_url).toBe('https://legacy.com/');

			const missing = claimTask({ tasksRoot: root, slug: 'ghost', stratum: 'multi-page' });
			expect(missing.ok).toBe(false);
		});
	});
});

describe('buildStatus / formatStatus', () => {
	test('assembles strata buckets and a per-task table incl. an unclaimed task', () => {
		withRoot((root) => {
			// claimed task, snapshot recorded + gold authored (2 items)
			createTask({
				tasksRoot: root,
				slug: 'alpha',
				entryUrl: 'https://alpha.com/',
				stratum: 'single-page'
			});
			const alpha = join(root, 'alpha');
			writeFileSync(
				join(alpha, 'manifest.json'),
				JSON.stringify({ entryUrl: 'https://alpha.com/' })
			);
			mkdirSync(join(alpha, 'gold'), { recursive: true });
			writeFileSync(
				join(alpha, 'gold', 'data.json'),
				JSON.stringify({
					policy_version: '2026-07-11',
					sources: ['https://alpha.com/menu'],
					items: [
						{ name: 'A', description: null, tags: [], optional_tags: [], price: 1 },
						{ name: 'B', description: null, tags: [], optional_tags: [], price: 2 }
					]
				})
			);

			// unclaimed task (no task.json), draft pending, no gold
			const beta = join(root, 'beta');
			mkdirSync(join(beta, 'gold'), { recursive: true });
			writeFileSync(join(beta, 'gold', 'draft.json'), '{}');

			const status = buildStatus(root);

			const single = status.byStratum.find((s) => s.stratum === 'single-page');
			expect(single?.slugs).toEqual(['alpha']);
			// unfilled strata are present but empty
			expect(status.byStratum.find((s) => s.stratum === 'pdf-menu')?.slugs).toEqual([]);

			const alphaRow = status.rows.find((r) => r.slug === 'alpha');
			expect(alphaRow).toMatchObject({
				stratum: 'single-page',
				recorded: true,
				authored: true,
				draftPending: false,
				itemCount: 2
			});
			const betaRow = status.rows.find((r) => r.slug === 'beta');
			expect(betaRow).toMatchObject({
				stratum: '(unset)',
				recorded: false,
				authored: false,
				draftPending: true,
				itemCount: null
			});

			const text = formatStatus(status);
			expect(text).toContain('pdf-menu');
			expect(text).toContain('EMPTY');
			expect(text).toContain('alpha');
			expect(text).toContain('(unset)');
		});
	});

	test('empty tasks root: no rows and every stratum EMPTY (CI-absent-style)', () => {
		withRoot((root) => {
			mkdirSync(root, { recursive: true });
			const status = buildStatus(root);
			expect(status.rows).toEqual([]);
			expect(status.byStratum.every((s) => s.slugs.length === 0)).toBe(true);
			expect(formatStatus(status)).toContain('(no tasks)');
		});
	});
});
