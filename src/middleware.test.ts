import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { SESSION_COOKIE_NAME, createSessionToken } from "./lib/auth";
import { middleware } from "./middleware";

function buildRequest(url: string, cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue !== undefined) {
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
  }
  return new NextRequest(new URL(url, "http://localhost"), { headers });
}

test("middleware redirects to /login when the session cookie is missing", async () => {
  const req = buildRequest("/gastos");
  const res = await middleware(req);
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toContain("/login");
});

test("middleware redirects to /login when the session cookie is invalid", async () => {
  const req = buildRequest("/gastos", "not-a-valid-token");
  const res = await middleware(req);
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toContain("/login");
});

test("middleware lets the request through when the session cookie is valid", async () => {
  const token = await createSessionToken();
  const req = buildRequest("/gastos", token);
  const res = await middleware(req);
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
});

test("middleware redirect uses the real Host header, not the request's internal base URL", async () => {
  // Reproduces a real production bug: self-hosted Next.js builds
  // `request.url` from its own listen address, not the client's Host
  // header, so a naive `new URL("/login", request.url)` redirected every
  // deployed user to http://localhost:3000/login regardless of the real
  // domain. This request's own URL says "http://localhost/gastos" (same
  // as buildRequest above) specifically to prove the redirect ignores
  // that and uses the headers instead.
  const headers = new Headers();
  headers.set("host", "mi-bot-whatsapp.duckdns.org");
  headers.set("x-forwarded-proto", "https");
  const req = new NextRequest(new URL("/gastos", "http://localhost"), { headers });
  const res = await middleware(req);
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("https://mi-bot-whatsapp.duckdns.org/login");
});
