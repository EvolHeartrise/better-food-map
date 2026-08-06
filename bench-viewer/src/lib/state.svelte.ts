/**
 * Shared viewer state: the filter slice, the averaging mode, and hash routing.
 *
 * Filters live in ONE place because every view must render against the same
 * slice — a per-chart filter is how two cards end up quietly disagreeing.
 */
import type { AverageMode, MetricKey } from './types';

/** A route is `#/view` or `#/view?arg=…`; kept trivially small on purpose. */
export type ViewName =
	| 'leaderboard'
	| 'frontier'
	| 'tasks'
	| 'runs'
	| 'run'
	| 'compare'
	| 'blacklist';

function readHash(): { view: ViewName; params: URLSearchParams } {
	const raw = location.hash.replace(/^#\/?/, '');
	const [path, query] = raw.split('?');
	const view = (path || 'leaderboard') as ViewName;
	return { view, params: new URLSearchParams(query ?? '') };
}

class Router {
	current = $state(readHash());

	constructor() {
		addEventListener('hashchange', () => {
			this.current = readHash();
		});
	}

	go(view: ViewName, params: Record<string, string> = {}): void {
		const query = new URLSearchParams(params).toString();
		location.hash = `#/${view}${query ? `?${query}` : ''}`;
	}

	param(key: string): string | null {
		return this.current.params.get(key);
	}
}

export const router = new Router();

class Filters {
	tasks = $state<string[]>([]);
	models = $state<string[]>([]);
	efforts = $state<string[]>([]);
	includeFailed = $state(true);
	/**
	 * Retired configurations are hidden by default.
	 *
	 * Opt-IN, not opt-out: the default question this dashboard answers is "what
	 * should we run", and a configuration already ruled out is noise in it — often
	 * loud noise, since several verdicts in the corpus were written about configs
	 * that scored WELL and lost on cost, so they rank high. Every view that hides
	 * anything reports the count, so the slice never narrows silently.
	 */
	includeBlacklisted = $state(false);
	mode = $state<AverageMode>('macro');
	metric = $state<MetricKey>('item_recall');
	/** Grouping dimensions for cells; empty means the server default. */
	dimensions = $state<string[]>([]);

	/**
	 * Bumped after a blacklist edit.
	 *
	 * Every view gets its data from `$derived(await fetch…(filters.query))`, which
	 * re-runs when the query STRING changes. Recording a verdict changes what the
	 * server would return without changing any filter, so the change rides in the
	 * query as an inert `_rev` param the server ignores. Without it, a config you
	 * just retired would sit on the leaderboard until the next navigation.
	 */
	revision = $state(0);

	/** Query string every data request shares, so all views see one slice. */
	get query(): string {
		const params = new URLSearchParams();
		for (const task of this.tasks) params.append('task', task);
		for (const model of this.models) params.append('model', model);
		for (const effort of this.efforts) params.append('effort', effort);
		if (!this.includeFailed) params.set('include_failed', '0');
		if (this.includeBlacklisted) params.set('include_blacklisted', '1');
		if (this.revision > 0) params.set('_rev', String(this.revision));
		return params.toString();
	}

	get active(): number {
		return (
			this.tasks.length +
			this.models.length +
			this.efforts.length +
			(this.includeFailed ? 0 : 1) +
			(this.includeBlacklisted ? 1 : 0)
		);
	}

	toggle(list: 'tasks' | 'models' | 'efforts', value: string): void {
		const current = this[list];
		this[list] = current.includes(value)
			? current.filter((entry) => entry !== value)
			: [...current, value];
	}

	/**
	 * Back to defaults — which means hiding blacklisted again, not showing
	 * everything. "Clear" restores the default slice; it is not "show all".
	 */
	reset(): void {
		this.tasks = [];
		this.models = [];
		this.efforts = [];
		this.includeFailed = true;
		this.includeBlacklisted = false;
	}
}

export const filters = new Filters();

/**
 * Force every view to re-read after a blacklist edit. Call it once, after the
 * server has confirmed the write — never optimistically, so what renders is
 * always what the file now says.
 */
export function refreshData(): void {
	filters.revision += 1;
}

/**
 * The `--effort` scope string the blacklist uses, from a display label.
 *
 * The facets spell "no --effort was passed" as `default(provider-default)` to
 * name which default applied; the blacklist spells that scope `default`. They
 * mean the same configuration and must not drift — an entry written as
 * `default(provider-default)` would match no run at all.
 */
export function blacklistEffort(label: string): string {
	return label.startsWith('default') ? 'default' : label;
}
