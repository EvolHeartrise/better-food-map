// Shared, client-safe tag display helpers. Kept here (not in `$lib/server/db`,
// which is server-only) so client components can format tags without pulling
// server code into the browser bundle — mirrors `$lib/category.ts`.

/**
 * How a tag's name should read in the UI. Curated dietary/course tags are stored
 * already capitalised ("Vegan", "Dessert"); title-casing the first letter is a
 * harmless no-op for them and keeps the helper robust if a lower-cased name ever
 * reaches it. Applied in one place — {@link FoodTag} — so a tag reads the same
 * wherever it appears.
 */
export function tagDisplayName(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}
