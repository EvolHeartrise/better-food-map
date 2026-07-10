// GET/PUT /api/v1/me/diet — the current user's saved diet (a single dietary tag
// id, or null). Mirrors the getDiet/setDiet remote functions via the shared
// read/write ($lib/server/diet), including the sanitizeDiet guard on both sides.
//   • GET  → the saved diet value (string | null), like getDiet.
//   • PUT { diet: string | null } → writes it (401 signed out) and returns the
//     resulting saved value (a rejected/unknown id reads back as null).
// CORS + no-store via the apiCors hook.
import * as v from 'valibot';
import { readDiet, writeDiet } from '$lib/server/diet';
import { parseOr400, readJsonBody, withApi } from '$lib/server/api';

const DietBodySchema = v.object({ diet: v.nullable(v.string()) });

export const GET = withApi(() => readDiet());

export const PUT = withApi(async (event) => {
	const { diet } = parseOr400(DietBodySchema, await readJsonBody(event.request));
	await writeDiet(diet);
	return readDiet();
});
