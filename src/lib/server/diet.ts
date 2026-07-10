// The saved-diet read/write, factored out of profile.remote.ts so the
// `getDiet`/`setDiet` remote functions AND the /api/v1/me/diet endpoint share ONE
// implementation — including the `sanitizeDiet` guard on both directions. The
// remote `setDiet` additionally refreshes its own query resource; that
// remote-only concern stays in the command, which calls writeDiet here.
import { requireDb, currentUser, requireUser } from './context';
import { getUserDiet, setUserDiet } from './db';
import { sanitizeDiet } from '$lib/diet-profile';

/**
 * The signed-in user's saved diet — a single curated dietary tag id, or `null`
 * when none is set (or signed out). Sanitized on read so a stored id no longer in
 * the catalog reads as "no filter" rather than a broken selection.
 */
export async function readDiet(): Promise<string | null> {
	const user = await currentUser();
	if (!user) return null;
	return sanitizeDiet(await getUserDiet(requireDb(), user.id));
}

/**
 * Saves the signed-in user's selected diet (a curated dietary tag id, or `null`
 * to clear it). The id is sanitized to a known dietary tag before storing — an
 * unknown value is stored as `null` (no filter). Requires auth (401 signed out).
 */
export async function writeDiet(dietId: string | null): Promise<void> {
	const user = await requireUser();
	await setUserDiet(requireDb(), user.id, sanitizeDiet(dietId), Date.now());
}
