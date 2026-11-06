import { expect, test } from "vitest";
import { createSessionToken, login, verifySessionToken } from "./auth";

test("verifySessionToken accepts a token from createSessionToken and rejects a tampered one", async () => {
  const token = await createSessionToken();
  expect(await verifySessionToken(token)).toBe(true);
  expect(await verifySessionToken(token + "x")).toBe(false);
});

test("verifySessionToken rejects garbage input", async () => {
  expect(await verifySessionToken("")).toBe(false);
  expect(await verifySessionToken("not-a-token")).toBe(false);
  expect(await verifySessionToken("a.b.c")).toBe(false);
});

// .env.test sets WEBAPP_USERNAME="testuser" and WEBAPP_PASSWORD_HASH to the
// bcrypt hash of "test-password-123".
test("login returns a valid session token for correct credentials", async () => {
  const token = await login("testuser", "test-password-123");
  expect(token).not.toBeNull();
  expect(await verifySessionToken(token!)).toBe(true);
});

test("login returns null for a wrong password", async () => {
  expect(await login("testuser", "wrong-password")).toBeNull();
});

test("login returns null for a wrong username", async () => {
  expect(await login("someone-else", "test-password-123")).toBeNull();
});
