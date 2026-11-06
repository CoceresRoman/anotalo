import { NextRequest, NextResponse } from "next/server";
// Imports from "./lib/session", not "./lib/auth": auth.ts also imports
// bcrypt (for login()), and Next.js always runs this file on the Edge
// runtime, where bcrypt's native addon crashes on load even if login() is
// never called. SESSION_COOKIE_NAME/verifySessionToken are re-exported
// from auth.ts too — same values, same single source of truth — this just
// avoids pulling bcrypt into the Edge bundle. See session.ts for details.
import { SESSION_COOKIE_NAME, verifySessionToken } from "./lib/session";

export async function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (!token || !(await verifySessionToken(token))) {
    const loginUrl = new URL("/login", requestOrigin(request));
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

// Self-hosted Next.js (`next start`), unlike Vercel, builds `request.url`
// from the server's own listen address rather than the Host header the
// client actually sent — behind Caddy that silently redirected everyone to
// http://localhost:3000/login instead of the real public domain (observed
// live on the production VM). Reading Host/X-Forwarded-* directly
// sidesteps that; they reach this process unmodified since Caddy is the
// only thing allowed to set them (see deploy/Caddyfile).
function requestOrigin(request: NextRequest): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return request.url;
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export const config = {
  // Every path runs through the middleware except the login page itself, the
  // login API route (would otherwise redirect-loop: no session yet is exactly
  // why you're calling it), the health check (used by uptime monitors that
  // don't carry a session cookie), Next's own static assets, the PWA
  // files (sw.js, manifest.json, icons/*) — the browser fetches these
  // without a session cookie (e.g. from the login page, or in the
  // background to check installability), and a redirect response for a
  // service worker's own script is invalid and silently kills
  // registration — and the cron routes (api/cron/*), which have their own
  // `secret` check (src/app/api/cron/cuota-reminder/route.ts) since
  // they're called by system cron with no browser session at all, so the
  // usual redirect-to-login would break them exactly like the PWA files
  // did before.
  matcher: [
    "/((?!login|api/auth/login|api/health|api/cron/|_next/static|_next/image|favicon.ico|sw.js|manifest.json|icons/).*)",
  ],
};
