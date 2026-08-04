/**
 * Shared viewer state: the filter slice, the averaging mode, and hash routing.
 *
 * Filters live in ONE place because every view must render against the same
 * slice — a per-chart filter is how two cards end up quietly disagreeing.
 */
import type { AverageMode, MetricKey } from './types';

/** A route is `#/view` or `#/view?arg=…`; kept trivially small on purpose. */
export type ViewName = 'leaderboard' | 'frontier' | 'tasks' | 'runs' | 'run' | 'compare';

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
	mode = $state<AverageMode>('macro');
	metric = $state<MetricKey>('item_recall');
	/** Grouping dimensions for cells; empty means the server default. */
	dimensions = $state<string[]>([]);

	/** Query string every data request shares, so all views see one slice. */
	get query(): string {
		const params = new URLSearchParams();
		for (const task of this.tasks) params.append('task', task);
		for (const model of this.models) params.append('model', model);
		for (const effort of this.efforts) params.append('effort', effort);
		if (!this.includeFailed) params.set('include_failed', '0');
		return params.toString();
	}

	get active(): number {
		return (
			this.tasks.length + this.models.length + this.efforts.length + (this.includeFailed ? 0 : 1)
		);
	}

	toggle(list: 'tasks' | 'models' | 'efforts', value: string): void {
		const current = this[list];
		this[list] = current.includes(value)
			? current.filter((entry) => entry !== value)
			: [...current, value];
	}

	reset(): void {
		this.tasks = [];
		this.models = [];
		this.efforts = [];
		this.includeFailed = true;
	}
}

export const filters = new Filters();
