/**
 * The canonical public origin (scheme + host, no trailing slash). ONE definition
 * shared by the venue head's `<link rel="canonical">`/`og:url` (+page.svelte),
 * the sitemap `<loc>`s ($lib/server/sitemap), and the geographic browse pages —
 * so nothing can disagree on the host crawlers should index. hooks.server.ts
 * 301-redirects every alias host onto it. Pure and client-safe (imported
 * relatively, never via `$lib`, so `bun test` resolves it).
 */
export const CANONICAL_ORIGIN = 'https://betterfoodmaps.com';
