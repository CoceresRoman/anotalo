// Session token creation/verification — split out of auth.ts specifically
// so src/middleware.ts can import SESSION_COOKIE_NAME/verifySessionToken
// without pulling bcrypt (used by auth.ts's login()) into its bundle.
//
// Next.js always runs middleware.ts on the Edge runtime, never Node.js —
// there is no config flag to opt out of this in Next 14. bcrypt is a native
// Node addon (node-gyp-build loads a compiled .node binary); merely having
// a top-level `import bcrypt from "bcrypt"` anywhere in middleware's module
// graph crashes at runtime under Edge ("Cannot read properties of undefined
// (reading 'modules')" from node-gyp-build) *even though* the code path
// that calls bcrypt (login()) is never invoked by middleware — the crash
// happens just from the module being loaded. Verified by testing directly:
// switching only the `node:crypto` import below to edge-compatible didn't
// help until login()/bcrypt were moved out of this file's import graph.
//
// This file used to also import `createHmac`/`timingSafeEqual` from the bare
// `crypto` specifier. That turned out to be ANOTHER Edge incompatibility,
// separate from the bcrypt one above: the Edge runtime's `crypto` polyfill
// does not implement `createHmac`/`timingSafeEqual` at all ("The edge
// runtime does not support Node.js 'crypto' module" — confirmed by hitting
// a protected route on the real `next dev` server with a cookie minted by
// the old implementation; the 500 pointed straight at the `sign()` call in
// this file). Node's `crypto` module only ever works here when Vitest runs
// this file directly in a Node process — it was never actually exercised
// under Edge until a real browser/server request hit the middleware.
//
// The fix: use the Web Crypto API (`crypto.subtle`), which is available
// globally in both Node 20+ and the Edge runtime, instead of Node's
// `crypto` module. This makes createSessionToken()/verifySessionToken()
// async (HMAC key import/sign/verify are all Promise-based in Web Crypto),
// so every call site now awaits them. `crypto.subtle.verify` does the
// constant-time signature comparison internally, so there's no more
// hand-rolled timingSafeEqual.
//
// auth.ts re-exports everything from this file, so every existing import
// of these names from "./auth" (route.ts, auth.test.ts, route.test.ts)
// keeps working unchanged. Only middleware.ts imports from here directly.

// Session tokens last 7 days. This is a personal single-user app with no
// "remember me" flow, so a long-lived session that survives browser/server
// restarts is more useful than a short one — the owner just stays logged in.
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Name of the cookie the login route sets and the middleware reads.
export const SESSION_COOKIE_NAME = "session";

const textEncoder = new TextEncoder();

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET environment variable is not set");
  }
  return secret;
}

function base64url(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = textEncoder.encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    bytes = new Uint8Array(input);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getHmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(getSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sign(payload: string): Promise<string> {
  const key = await getHmacKey();
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return base64url(signature);
}

export async function createSessionToken(): Promise<string> {
  const now = Date.now();
  const payload = JSON.stringify({ iat: now, exp: now + SESSION_DURATION_MS });
  const encodedPayload = base64url(payload);
  const signature = await sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export async function verifySessionToken(token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [encodedPayload, signature] = parts;

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64urlDecode(signature);
  } catch {
    return false;
  }

  const key = await getHmacKey();
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes as BufferSource,
    textEncoder.encode(encodedPayload)
  );
  if (!valid) return false;

  let payload: { iat: number; exp: number };
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(encodedPayload)));
  } catch {
    return false;
  }

  if (typeof payload.exp !== "number" || Date.now() > payload.exp) {
    return false;
  }

  return true;
}
