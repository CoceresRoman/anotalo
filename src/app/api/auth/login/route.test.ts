import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { SESSION_COOKIE_NAME, verifySessionToken } from "../../../../lib/auth";
import { POST } from "./route";

// .env.test sets WEBAPP_USERNAME="testuser" and WEBAPP_PASSWORD_HASH to the
// bcrypt hash of "test-password-123". Each test uses its own IP so the
// shared in-memory rate limiter in rateLimit.ts doesn't leak between tests.
function buildLoginRequest(body: unknown, ip: string): NextRequest {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

test("POST returns 200 and sets an httpOnly session cookie for correct credentials", async () => {
  const response = await POST(
    buildLoginRequest({ username: "testuser", password: "test-password-123" }, "203.0.113.1")
  );

  expect(response.status).toBe(200);

  const cookie = response.cookies.get(SESSION_COOKIE_NAME);
  expect(cookie).toBeDefined();
  expect(cookie?.httpOnly).toBe(true);
  expect(await verifySessionToken(cookie!.value)).toBe(true);
});

test("POST returns 401 and sets no cookie for incorrect credentials", async () => {
  const response = await POST(
    buildLoginRequest({ username: "testuser", password: "wrong-password" }, "203.0.113.2")
  );

  expect(response.status).toBe(401);
  expect(response.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
});

test("POST returns 429 once the per-IP login rate limit is exceeded", async () => {
  const ip = "203.0.113.3";
  const badAttempt = () =>
    POST(buildLoginRequest({ username: "testuser", password: "wrong-password" }, ip));

  for (let i = 0; i < 5; i++) {
    const response = await badAttempt();
    expect(response.status).toBe(401);
  }

  const blockedResponse = await badAttempt();
  expect(blockedResponse.status).toBe(429);
});
