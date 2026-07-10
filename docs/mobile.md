# Mobile app (Capacitor: iOS + Android)

BetterFoodMaps ships as a native iOS/Android app that wraps the same SvelteKit
frontend as the website. This document covers how it is built, how auth and deep
links work, and the dev workflow; the remaining path to a store submission is
tracked in the GitHub issues listed at the bottom.

## Architecture

The app is the **same codebase** as the web app, built in a second mode:

- **Bundled SPA.** `APP_TARGET=capacitor bun run build` (`bun run build:app`)
  builds a client-only single-page app with `@sveltejs/adapter-static`
  (fallback `index.html`) into `build-app/`. The bundle — HTML, JS, CSS, and the
  vendored `static/basemaps-assets/` map glyphs+sprites — is packaged **inside**
  the native app and served locally by the WebView. There is no `server.url`;
  the app works from its own origin.
- **`/api/v1` + bearer auth.** The app has no SvelteKit server, so it can't call
  remote functions. Instead the four remote modules (`data`/`user`/`profile`/
  `locale`) are **aliased at build time** to fetch shims in `src/lib/app/` that
  call the JSON API at `https://betterfoodmaps.com/api/v1/*` (see
  `src/routes/api/v1/` and `src/lib/server/api.ts`). Every request carries the
  session as `Authorization: Bearer <token>`; the token is stored with
  `@capacitor/preferences`.
- **System-browser OAuth.** Sign-in opens Google in the **system browser** (not
  the WebView), and the server redirects back via a custom URL scheme — see
  below.

### Dual build, one codebase

Selected by the `APP_TARGET=capacitor` env var, which `vite.config.ts` turns
into the compile-time constant `__IS_APP__` (via Vite `define`) surfaced as
`IS_APP` from `src/lib/app/platform.ts`. In app mode the config:

| Switch                      | Web                   | App (`APP_TARGET=capacitor`)                                                                     |
| --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| Adapter                     | `adapter-cloudflare`  | `adapter-static` (SPA, `fallback: index.html`, out `build-app/`)                                 |
| Routes (`kit.files.routes`) | `src/routes`          | `src/routes-app` (thin `+layout`/`+page`/`+error` wrappers, `ssr = false` / `prerender = false`) |
| `$lib/*.remote` imports     | real remote functions | aliased to `src/lib/app/*-api.ts` fetch shims (a `pre` resolveId plugin)                         |
| `@capacitor/*`              | never bundled         | bundled                                                                                          |

The web build is byte-for-byte behaviorally identical: the app aliases, the
static adapter, and every `@capacitor/*` import are gated on `IS_APP`/
`__IS_APP__` and applied only when `APP_TARGET=capacitor`. `src/hooks.ts` (the
universal `/locations/*` reroute) is untouched and works in both builds.

`__API_ORIGIN__` (default `https://betterfoodmaps.com`) is the API origin; set
`API_ORIGIN=…` at build time to point the app at a local/staging server.

## Auth + deep-link flow

1. Signed-out, tapping **Sign in** calls `signIn()` (`src/lib/app/auth.ts`),
   which generates a random 256-bit `state`, persists it with
   `@capacitor/preferences` (so it survives an Android singleTask relaunch during
   the browser round trip), and opens the system browser at
   `https://betterfoodmaps.com/auth/login/google?client=app&state=<state>`.
2. After Google consent, the server (marked `?client=app`) 303-redirects to
   `betterfoodmaps://auth/callback?code=<one-time code>&state=<state>`, reflecting
   the same `state` back. The server carries the state through the round trip in
   the app-client cookie (validated to a strict hex charset), never in D1 — it
   only relays it back to the app for a client-side equality check.
3. The OS routes that custom-scheme URL to the app. `@capacitor/app`'s
   `appUrlOpen` listener (registered once from the app layout via
   `initApp()` in `src/lib/app/bootstrap.ts`) catches it and — **only when the
   reflected `state` strictly matches the persisted one**, so the code is bound to
   the sign-in this app instance started (login-CSRF / session-fixation defense) —
   POSTs the code to `/api/v1/auth/token`, stores the returned bearer token, closes
   the in-app browser, and refreshes the user/likes/diet resources. The persisted
   state is cleared on every callback (match or not), so a code can never be
   redeemed twice or outside an in-flight, self-initiated sign-in.
4. Sign-out POSTs `/api/v1/auth/signout`, clears the stored token, and refreshes
   the same resources.

The custom scheme `betterfoodmaps` is registered natively:

- **iOS:** `CFBundleURLTypes` in `ios/App/App/Info.plist`.
- **Android:** an `<intent-filter>` in
  `android/app/src/main/AndroidManifest.xml`.

Shared **venue links** (`https://betterfoodmaps.com/locations/*`) opened as deep
links are client-navigated inside the app. Universal Links / Android App Links
(opening `https://` venue URLs directly in the app) are **not** configured —
they need store/team accounts and a hosted association file; see the `TODO`
comments in `Info.plist` and `AndroidManifest.xml`.

## Building & running

Prerequisites for the native builds: **iOS needs macOS + Xcode**; **Android
needs the Android SDK** (and Android Studio for the emulator). Neither can be
built on a plain Linux CI box — CI only runs `bun run build:app` (the web
bundle) to keep the dual-build config from rotting; it does **not** run
gradle/xcode.

```bash
bun install

# Build the SPA bundle and copy it into the native projects.
bun run cap:sync            # = build:app + cap sync

# Open the native IDEs to run/emulate/archive.
bun run cap:open:ios        # macOS + Xcode
bun run cap:open:android    # Android Studio
```

The generated `ios/` and `android/` projects are committed. Capacitor 8 uses
Swift Package Manager (no CocoaPods), so `cap add ios` completes on Linux; the
actual iOS build/run still requires a Mac.

### Dev workflow (point the app at a local server)

Build the app bundle against your local dev server so the WebView's API calls
hit it:

```bash
# Terminal 1: the SvelteKit dev server (serves /api/v1 too).
bun run dev                                   # http://localhost:5050

# Terminal 2: build the app bundle pointed at it, then sync.
API_ORIGIN=http://localhost:5050 bun run build:app && cap sync
```

The `/api/v1` CORS allowlist (`src/lib/server/api-cors.ts`) covers the two
production app origins — `capacitor://localhost` (iOS) and `https://localhost`
(Android) — plus `http://localhost:5050` (local `vite dev`) **only in dev** (the
allowlist is built from `dev` at the hook call site, so the dev origin never ships
in production).

### Map tiles & assets

`LocationMap` builds glyph/sprite URLs from `location.origin`, which in the app
is the local WebView origin — so glyphs and sprites resolve to the bundled
`basemaps-assets/` (copied into `build-app/` by adapter-static). Vector **tiles**
are fetched cross-origin from `https://tiles.betterfoodmaps.com`; that worker's
`ALLOWED_ORIGINS` must include the app origins (see ship blockers).

### Localization

The app has no server to negotiate a per-request locale, so the UI language is
resolved from the **device** (`navigator.languages`, matched against the
supported locales, base-locale fallback) in `hooks.client.ts`. There is no
in-app language override; the account menu's language picker only persists a
signed-in user's choice to their **web** account (`PUT /api/v1/me/locale`).

## Remaining work

The one-off deploy steps from the initial ship (production D1 migration
`0026_app_auth_codes.sql`, tiles-worker redeploy with the app origins) are
**done**. Everything still standing between this code and the app stores is
tracked as GitHub issues under the
[`mobile` label](https://github.com/EvolHeartrise/better-food-map/issues?q=is%3Aissue+is%3Aopen+label%3Amobile)
— first on-device builds (#290), Sign in with Apple (#291), icons/splash
(#292), signing & store listings (#293), native affordances for App Store 4.2
(#294), Universal/App Links (#295), session-expiry UX (#296), in-app language
override (#297).
