// Page options for the Capacitor SPA build (this route tree is selected via
// `kit.files.routes` only when APP_TARGET=capacitor — see vite.config.ts). The
// app is a client-only bundle served locally by the WebView: no SSR, and no
// prerendering (every path is served through adapter-static's fallback shell).
export const ssr = false;
export const prerender = false;
