// Chooses the runtime name for a host-locked cookie. In production every auth
// cookie carries the `__Host-` prefix, which the browser only accepts when the
// cookie is Secure, has Path=/ and no Domain attribute — locking it to this
// exact origin so a subdomain (or a plain-HTTP subdomain MITM; HSTS here
// deliberately omits includeSubDomains) can never toss a shadowing cookie and
// fixate a session. Under `vite dev` the prefix must be dropped: dev serves
// plain-HTTP localhost without `Secure`, and browsers reject a non-Secure
// `__Host-` cookie outright.
//
// `dev` is passed in (rather than importing `$app/environment`) so this module
// stays `$app`-free and bun test can exercise both branches directly.
export function hostCookieName(base: string, dev: boolean): string {
	return dev ? base : `__Host-${base}`;
}
