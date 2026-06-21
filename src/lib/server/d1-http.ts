/**
 * A `D1Like` client backed by the Cloudflare D1 REST API, for use OUTSIDE the
 * Worker runtime — the MCP server (`scripts/db-mcp-server.ts`) runs under Bun
 * and talks to the *same* production D1 the deployed Worker reads from.
 *
 * Inside the Worker, use the native `platform.env.DB` binding instead; this
 * file must never be imported into the app/Worker bundle.
 *
 * REST endpoint: POST /accounts/{account_id}/d1/database/{database_id}/query
 * with body `{ sql, params }` and `Authorization: Bearer <token>`. A request
 * whose `sql` holds several `;`-separated statements is executed as one atomic
 * batch — that is how {@link batch} preserves all-or-nothing semantics.
 */
import type { D1Like, D1PreparedLike } from './db';

export interface D1HttpConfig {
	accountId: string;
	databaseId: string;
	apiToken: string;
}

/** Shape of one element of the REST response's top-level `result` array. */
interface D1QueryResult {
	results?: unknown[];
	success?: boolean;
	meta?: { changes?: number; last_row_id?: number; rows_read?: number; rows_written?: number };
}

interface D1ApiResponse {
	result?: D1QueryResult[];
	success?: boolean;
	errors?: { code?: number; message?: string }[];
	messages?: { message?: string }[];
}

/**
 * Reads D1 connection details from the environment, applying any overrides.
 * Throws a clear error if a value is missing so misconfiguration fails loudly
 * at startup rather than on the first query.
 */
export function resolveConfig(overrides: Partial<D1HttpConfig> = {}): D1HttpConfig {
	const accountId = overrides.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
	const databaseId = overrides.databaseId ?? process.env.CLOUDFLARE_DATABASE_ID;
	const apiToken = overrides.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;

	const missing = [
		['CLOUDFLARE_ACCOUNT_ID', accountId],
		['CLOUDFLARE_DATABASE_ID', databaseId],
		['CLOUDFLARE_API_TOKEN', apiToken]
	]
		.filter(([, value]) => !value)
		.map(([name]) => name);

	if (!accountId || !databaseId || !apiToken) {
		throw new Error(
			`Missing D1 credentials: ${missing.join(', ')}. Set them in .env (see .env.example). ` +
				`Create a token at https://dash.cloudflare.com/profile/api-tokens with D1 Edit permission.`
		);
	}

	return { accountId, databaseId, apiToken };
}

/** Renders a bound value as a SQL literal. Used only for {@link batch} inlining. */
function toSqlLiteral(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'boolean') return value ? '1' : '0';
	// Remaining values are strings; single-quote and double up embedded quotes.
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Substitutes each `?` placeholder in `sql` with the next bound value as an
 * escaped literal. Safe here because every statement passed to {@link batch} is
 * code-authored (in db.ts) and contains no `?` inside string literals — the
 * only `?` are real placeholders. Never use this for caller-supplied SQL.
 */
function inlineParams(sql: string, params: unknown[]): string {
	let i = 0;
	return sql.replace(/\?/g, () => {
		if (i >= params.length) throw new Error(`Too few params for statement: ${sql}`);
		return toSqlLiteral(params[i++]);
	});
}

class HttpD1PreparedStatement implements D1PreparedLike {
	constructor(
		private readonly cfg: D1HttpConfig,
		readonly sql: string,
		readonly params: unknown[] = []
	) {}

	bind(...values: unknown[]): D1PreparedLike {
		return new HttpD1PreparedStatement(this.cfg, this.sql, values);
	}

	async first<T = unknown>(): Promise<T | null> {
		const { results } = await queryOne(this.cfg, this.sql, this.params);
		return (results?.[0] as T | undefined) ?? null;
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		const { results } = await queryOne(this.cfg, this.sql, this.params);
		return { results: (results ?? []) as T[] };
	}

	async run(): Promise<{ meta: { changes: number } }> {
		const { meta } = await queryOne(this.cfg, this.sql, this.params);
		return { meta: { changes: meta?.changes ?? 0 } };
	}
}

/** POSTs a single statement (with bound params) to the D1 REST API. */
async function queryOne(cfg: D1HttpConfig, sql: string, params: unknown[]): Promise<D1QueryResult> {
	const [first] = await callApi(cfg, { sql, params });
	return first ?? {};
}

/** Low-level call to the D1 `query` endpoint. Returns the `result` array. */
async function callApi(
	cfg: D1HttpConfig,
	body: { sql: string; params?: unknown[] }
): Promise<D1QueryResult[]> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${cfg.apiToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});

	let json: D1ApiResponse;
	try {
		json = (await res.json()) as D1ApiResponse;
	} catch {
		throw new Error(`D1 API returned non-JSON response (HTTP ${res.status}).`);
	}

	if (!res.ok || json.success === false) {
		const detail =
			json.errors?.map((e) => e.message ?? JSON.stringify(e)).join('; ') || `HTTP ${res.status}`;
		throw new Error(`D1 query failed: ${detail}`);
	}

	return json.result ?? [];
}

/** Creates a `D1Like` client over the Cloudflare D1 REST API. */
export function createHttpD1(overrides: Partial<D1HttpConfig> = {}): D1Like {
	const cfg = resolveConfig(overrides);

	return {
		prepare(sql: string): D1PreparedLike {
			return new HttpD1PreparedStatement(cfg, sql);
		},

		async batch(statements: D1PreparedLike[]): Promise<unknown[]> {
			if (statements.length === 0) return [];
			// Inline each statement's bound params, then send them as one
			// semicolon-joined request, which D1 runs as a single atomic batch.
			const sql = statements
				.map((s) => {
					const st = s as HttpD1PreparedStatement;
					return inlineParams(st.sql, st.params);
				})
				.join(';\n');
			return callApi(cfg, { sql });
		}
	};
}
