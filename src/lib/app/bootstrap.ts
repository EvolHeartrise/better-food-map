// One-time app bootstrap, called from the app layout wrapper's onMount (app
// build only — see src/routes-app/+layout.svelte). Wires up everything the
// Capacitor client needs at startup and returns a cleanup for teardown. Imports
// @capacitor/* transitively, so it must NEVER be reached by the web bundle.
import { Browser } from '@capacitor/browser';
import { registerDeepLinks } from './auth';

/**
 * Opens external http(s) links in the SYSTEM browser instead of navigating the
 * WebView away from the bundled app. Venue source/directions links point at
 * other origins; letting the WebView follow them would strand the user outside
 * the app with no chrome to get back. Same-origin/relative links (the app's own
 * routes) are left to the router.
 */
function handleExternalLinkClick(event: MouseEvent): void {
	if (event.defaultPrevented || event.button !== 0) return;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	const anchor = (event.target as Element | null)?.closest('a');
	if (!anchor) return;
	const href = anchor.getAttribute('href');
	if (!href) return;

	let url: URL;
	try {
		url = new URL(href, location.href);
	} catch {
		return;
	}
	const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
	if (isHttp && url.host !== location.host) {
		event.preventDefault();
		void Browser.open({ url: url.href }).catch(() => {});
	}
}

/**
 * Initializes the app; returns a teardown that removes the listeners. The
 * persisted bearer token is NOT loaded here — api-client loads it lazily and
 * every request awaits it (token-store.ensureLoaded), so the map page's first
 * getCurrentUser/getDiet fetch already reflects the signed-in state.
 */
export function initApp(): () => void {
	// Deep-link (OAuth callback + shared venue links) listener.
	const deepLinks = registerDeepLinks();

	// External-link interception.
	document.addEventListener('click', handleExternalLinkClick, { capture: true });

	return () => {
		void deepLinks.then((handle) => handle.remove()).catch(() => {});
		document.removeEventListener('click', handleExternalLinkClick, { capture: true });
	};
}
