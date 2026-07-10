// Compile-time platform constants for the dual (web / Capacitor) build.
//
// The values are INLINED by Vite `define` (see vite.config.ts): `__IS_APP__`
// becomes the boolean literal `true` in the Capacitor build and `false` in the
// default web build, and `__API_ORIGIN__` the origin the app's JSON API lives at
// (https://betterfoodmaps.com by default, overridable to a local dev server).
//
// Because they resolve to literals at build time, `IS_APP` gates tree-shake
// cleanly: an `if (IS_APP)` / `{#if IS_APP}` branch is dropped whole from the
// build where it is false. IMPORTANT (see the "Dev-only tree-shaking" note in
// this repo's memory): only a compile-time constant tree-shakes. When a branch
// must NOT ship to the web bundle at all — notably a dynamic `import()` of a
// `$lib/app/**` module that pulls in `@capacitor/*` — gate it on the raw
// `__IS_APP__` define token directly (a live imported binding like `IS_APP` is
// not guaranteed to fold across modules under Rollup), so the dead branch and
// its import are eliminated. This module itself imports no `@capacitor/*` code,
// so it is safe to import from shared components in BOTH builds.
export const IS_APP: boolean = __IS_APP__;

/** Origin of the /api/v1 JSON API the Capacitor client talks to. */
export const API_ORIGIN: string = __API_ORIGIN__;
