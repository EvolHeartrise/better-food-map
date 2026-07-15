// A minimal client-side stand-in for a SvelteKit remote `query`'s return value,
// for the Capacitor build. The real remote functions hand components a value
// that is BOTH awaitable and carries a reactive `.current` plus `.refresh()`;
// the app can't speak the remote-function wire protocol, so these shims fetch
// over /api/v1 (see api-client) and re-expose the SAME surface the components
// already consume:
//
//   • `await getX()` / `getX().catch(fn)`  — thenable + catch (used by
//     getCurrentUser/getBookmarks/getUserLocation/getLocationData);
//   • `getX().current` (reactive, non-suspending) + `getX().refresh()` — used by
//     getStats/getDiet, and by the auth flow to re-pull user/likes/diet.
//
// `.current` is deliberately LAZY (it does not kick off a fetch on read) to
// mirror the exact behaviour +page.svelte compensates for: a fresh client query
// with no SSR-serialized value sits `undefined` until an explicit `.refresh()`.
// Awaiting the resource (or `.catch`) DOES start the fetch. Reactivity: `then`
// and the `current` getter read a `$state` version/value, so `.refresh()`
// (which bumps the version and swaps in a new fetch) re-runs any `$derived`/
// `$effect` that awaited or read the resource.

/** The reactive resource surface a component consumes (subset of a remote query). */
export interface QueryResource<T> extends PromiseLike<T> {
	/** Latest resolved value, or `undefined` until the first fetch settles. Reactive. */
	readonly current: T | undefined;
	/** Forces a re-fetch; resolves with the new value. Reactive consumers re-run. */
	refresh(): Promise<T>;
	/** Promise-style rejection handler (the components call `.catch(...)`). */
	catch<R = never>(onRejected: (reason: unknown) => R | PromiseLike<R>): Promise<T | R>;
}

class Resource<T> implements QueryResource<T> {
	readonly #run: () => Promise<T>;
	#current = $state<T | undefined>(undefined);
	// Bumped by refresh(); read in `then`/`current` so a refresh re-runs consumers.
	#version = $state(0);
	#promise: Promise<T> | null = null;

	constructor(run: () => Promise<T>) {
		this.#run = run;
	}

	#exec(): Promise<T> {
		return this.#run().then((value) => {
			this.#current = value;
			return value;
		});
	}

	#ensure(): Promise<T> {
		// Start the fetch on first await; reuse the in-flight/last promise after.
		this.#promise ??= this.#exec();
		return this.#promise;
	}

	get current(): T | undefined {
		return this.#current;
	}

	refresh(): Promise<T> {
		this.#promise = this.#exec();
		this.#version++;
		return this.#promise;
	}

	// A deliberate thenable: this shim REPLACES a remote query's awaitable return
	// value, so `await getX()` must work exactly as it did on the web.
	// oxlint-disable-next-line no-thenable
	then<R1 = T, R2 = never>(
		onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
		onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
	): Promise<R1 | R2> {
		// Reading #version here (during a $derived's synchronous phase, before the
		// await suspends) is what subscribes an awaiting consumer to refresh().
		void this.#version;
		return this.#ensure().then(onFulfilled, onRejected);
	}

	catch<R = never>(onRejected: (reason: unknown) => R | PromiseLike<R>): Promise<T | R> {
		return this.then(undefined, onRejected);
	}
}

/** Builds a no-argument query shim: one shared resource (like a singleton query). */
export function makeQuery<T>(run: () => Promise<T>): () => QueryResource<T> {
	let resource: Resource<T> | undefined;
	return () => (resource ??= new Resource(run));
}

/**
 * Builds a single-argument query shim, memoized per argument so the SAME arg
 * returns the SAME resource — replicating the remote query's per-argument dedup
 * (e.g. opening a venue twice costs one /api/v1/locations/:id fetch).
 */
export function makeArgQuery<A, T>(
	run: (arg: A) => Promise<T>,
	keyOf: (arg: A) => string = (arg) => JSON.stringify(arg)
): (arg: A) => QueryResource<T> {
	const cache = new Map<string, Resource<T>>();
	return (arg: A) => {
		const key = keyOf(arg);
		let resource = cache.get(key);
		if (!resource) {
			resource = new Resource(() => run(arg));
			cache.set(key, resource);
		}
		return resource;
	};
}
