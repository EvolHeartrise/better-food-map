import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor config for the BetterFoodMaps mobile app. The web bundle is LOCAL
// (built by `bun run build:app` into `build-app/`, copied into the native
// projects by `cap sync`) — there is no `server.url`, so the app runs offline-
// capable from its own origin:
//   • iOS    serves from  capacitor://localhost
//   • Android serves from https://localhost   (default androidScheme: 'https')
// Both origins are on the /api/v1 CORS allowlist (src/lib/server/api-cors.ts).
//
// The custom URL scheme used for the OAuth deep-link callback
// (betterfoodmaps://auth/callback) is registered NATIVELY, not here:
//   • iOS:     CFBundleURLTypes in ios/App/App/Info.plist
//   • Android: an <intent-filter> in android/app/src/main/AndroidManifest.xml
const config: CapacitorConfig = {
	appId: 'com.betterfoodmaps.app',
	appName: 'BetterFoodMaps',
	webDir: 'build-app'
};

export default config;
