-- Migration 0025: one-time codes for the mobile-app OAuth hand-off.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
-- D1 migrations are MANUAL — CI deploys the Worker but never runs them, so this
-- must be applied by hand at deploy time (bun run d1:migrate).
--
-- The mobile app (Capacitor) cannot use cookies for its session, and Google
-- blocks OAuth inside a WebView, so it signs in through the SYSTEM browser: it
-- opens the normal /auth/login/google flow marked ?client=app, and the callback —
-- rather than setting the browser session cookie the app can't read — mints a
-- short-lived (~5 min) one-time CODE and redirects to a custom scheme the app
-- intercepts (betterfoodmaps://auth/callback?code=…). The app then exchanges that
-- code for a real session token at POST /api/v1/auth/token (see
-- src/lib/server/app-auth.ts and src/routes/api/v1/auth/*).
--
-- Only the code's SHA-256 hash is stored (PK), never the raw code — mirroring the
-- sessions table (migration 0007), so a leak of this table can't be replayed as a
-- redeemable code. Redemption is single-use via DELETE … RETURNING (the row is
-- consumed on first exchange; a replay finds it gone). Written ONLY by the
-- deployed app at runtime through platform.env.DB (the MCP server never touches
-- it); timestamps are INTEGER Unix milliseconds supplied explicitly by the app,
-- carrying no DEFAULT, per the 0007 convention. The row cascades with its user.
CREATE TABLE IF NOT EXISTS app_auth_codes (
	code_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);

-- Supports the opportunistic expired-code sweep (deleteExpiredAppAuthCodes),
-- fired from the token-exchange endpoint so abandoned sign-ins don't accumulate.
CREATE INDEX IF NOT EXISTS idx_app_auth_codes_expires_at ON app_auth_codes (expires_at);
