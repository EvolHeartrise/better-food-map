// Deterministic APPLY step of the course-tag audit session (no LLM involved).
//
//   bun scripts/course-tag-audit/apply-classifications.ts classifications.json [applied-log.json]
//
// Input: the classification workflow's output — [{id, course, note?}] where
// course ∈ food | dessert | drink | dessert+drink | unsure. "unsure" entries
// are skipped and reported for manual review.
//
// Applies each verdict as additive `INSERT OR IGNORE INTO item_tags` rows —
// which preserves existing dietary tags by construction (nothing is replaced),
// exactly what update_items with a merged tag set would produce, minus the
// per-item reads. Two safety rails:
//   1. an item that ALREADY has a required course tag is skipped (never
//      overwrite a human/agent-applied course, and never create a food+dessert
//      conflict from a stale classification);
//   2. every applied row is appended to the log file (default
//      course-tag-applied-log.json beside the input) so a session is reversible
//      (rollback = DELETE those (item_id, tag_id) pairs).

import { spawnSync } from 'node:child_process';
import { TAGS } from '../../src/lib/tags';

const [, , inputPath, logPath = 'course-tag-applied-log.json'] = process.argv;
if (!inputPath) {
	console.error('usage: bun apply-classifications.ts <classifications.json> [applied-log.json]');
	process.exit(1);
}

const courseIds = new Set(TAGS.filter((t) => t.tag_type === 'course').map((t) => t.id));
const courseList = [...courseIds].map((c) => `'${c}'`).join(',');

type Cls = { id: string; course: string; note?: string };
const input: Cls[] = JSON.parse(await Bun.file(inputPath).text());
const unsure = input.filter((c) => c.course === 'unsure');
const verdicts = input.filter((c) => c.course !== 'unsure');
const bad = verdicts.filter(
	(c) => !(c.course === 'dessert+drink' || courseIds.has(c.course)) || !/^[0-9a-f-]{36}$/.test(c.id)
);
if (bad.length) {
	console.error('invalid classifications: ' + JSON.stringify(bad));
	process.exit(1);
}

function d1(sql: string): unknown[] {
	const run = spawnSync(
		'bunx',
		['wrangler', 'd1', 'execute', 'better-food-map', '--remote', '--json', '--command', sql],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
	);
	if (run.status !== 0) throw new Error(run.stderr);
	return JSON.parse(run.stdout.slice(run.stdout.indexOf('[')))[0].results;
}

// Rail 1: drop verdicts for items that already carry a required course tag.
const idList = verdicts.map((c) => `'${c.id}'`).join(',');
const alreadyTagged = new Set(
	(
		d1(
			`SELECT DISTINCT item_id FROM item_tags WHERE optional = 0 AND tag_id IN (${courseList}) AND item_id IN (${idList})`
		) as Array<{ item_id: string }>
	).map((r) => r.item_id)
);
const toApply = verdicts.filter((c) => !alreadyTagged.has(c.id));

const rows = toApply.flatMap((c) =>
	(c.course === 'dessert+drink' ? ['dessert', 'drink'] : [c.course]).map((tag) => ({
		id: c.id,
		tag
	}))
);
if (rows.length > 0) {
	const values = rows.map((r) => `('${r.id}', '${r.tag}', 0)`).join(',\n');
	d1(`INSERT OR IGNORE INTO item_tags (item_id, tag_id, optional) VALUES ${values}`);
}

// Rail 2: append to the reversibility log.
const log = (await Bun.file(logPath).exists()) ? JSON.parse(await Bun.file(logPath).text()) : [];
log.push(...rows.map((r) => ({ item_id: r.id, tag_id: r.tag })));
await Bun.write(logPath, JSON.stringify(log, null, 1));

const remaining = d1(
	`SELECT COUNT(*) AS n FROM items i WHERE NOT EXISTS (SELECT 1 FROM item_tags it WHERE it.item_id = i.id AND it.optional = 0 AND it.tag_id IN (${courseList}))`
) as Array<{ n: number }>;

console.log(
	JSON.stringify({
		applied_items: toApply.length,
		applied_rows: rows.length,
		skipped_already_tagged: alreadyTagged.size,
		unsure: unsure.map((u) => ({ id: u.id, note: u.note ?? null })),
		backlog_remaining: remaining[0].n,
		log: logPath
	})
);
