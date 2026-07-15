// The review moderation console: the reported/hidden review queue plus hide/un-hide
// actions. Deliberately a `+page.server.ts` (load + form actions) rather than remote
// functions — it is admin-only and WEB-only, so keeping it server-side keeps the
// moderation surface out of the client/app bundle entirely (the app never has to
// stub it). Every entry point calls requireAdmin ($lib/server/context), which 403s a
// non-admin, so the queue read and both actions are gated identically. Dev-facing, so
// its strings stay English (out of the message catalog), like the other internal tools.
import * as v from 'valibot';
import { fail } from '@sveltejs/kit';
import { readModerationQueue, hideReview, unhideReview } from '$lib/server/reviews';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// requireAdmin() runs inside readModerationQueue → a non-admin gets a 403 here.
	return readModerationQueue();
};

const ActionSchema = v.object({
	target: v.picklist(['location', 'item']),
	reviewId: v.pipe(v.string(), v.maxLength(128))
});

async function parse(
	request: Request
): Promise<{ target: 'location' | 'item'; reviewId: string } | null> {
	const form = await request.formData();
	const result = v.safeParse(ActionSchema, {
		target: form.get('target'),
		reviewId: form.get('reviewId')
	});
	return result.success ? result.output : null;
}

export const actions: Actions = {
	hide: async ({ request }) => {
		const a = await parse(request);
		if (!a) return fail(400, { message: 'Invalid request.' });
		await hideReview(a.target, a.reviewId); // requireAdmin inside
		return { ok: true };
	},
	unhide: async ({ request }) => {
		const a = await parse(request);
		if (!a) return fail(400, { message: 'Invalid request.' });
		await unhideReview(a.target, a.reviewId); // requireAdmin inside
		return { ok: true };
	}
};
