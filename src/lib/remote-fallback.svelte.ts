// Hydration fallback for a remote query read only via `.current`.
//
// A query instance that is only ever read via `.current` (never awaited or
// rendered) serializes no result during SSR — and a client-side instance with
// no serialized result has been observed to stay pending forever rather than
// issuing its own fetch (experimental remoteFunctions). Without a nudge,
// `current` would sit undefined and its consumer would never fill in (the
// stats overlay stuck on placeholders, a signed-in user's saved diet never
// seeding the selector). One explicit refresh() fills it.
//
// Call this from inside an `$effect`: reading `resource.current` there makes the
// effect re-run only when `current` changes, so a persistent failure can't loop
// it, and once a value lands it never fires again.

interface RefreshableResource {
	readonly current: unknown;
	refresh(): Promise<unknown>;
}

export function refreshIfUnhydrated(resource: RefreshableResource): void {
	if (resource.current === undefined) {
		void resource.refresh().catch(() => {});
	}
}
