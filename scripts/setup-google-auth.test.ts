import { beforeEach, expect, test, vi } from "vitest";

// This script's interactive main() (printing the consent URL, prompting for
// pasted input, exchanging it for real) can't be exercised without a real
// Google account authorizing a real consent screen — see task-11-report.md.
// What IS fully testable without any of that: the pure URL-building logic,
// the pasted-input parsing, and the token-exchange-and-save logic, with
// googleapis itself mocked. This file covers exactly those three, per the
// task brief's explicit carve-out.
const mockGetToken = vi.hoisted(() => vi.fn());
const mockGenerateAuthUrl = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("node:fs/promises", () => ({ writeFile: mockWriteFile, readFile: vi.fn() }));

import {
  buildConsentUrl,
  exchangeAndSaveToken,
  extractAuthorizationCode,
} from "./setup-google-auth";

function fakeOAuth2Client() {
  return {
    generateAuthUrl: mockGenerateAuthUrl,
    getToken: mockGetToken,
  } as unknown as Parameters<typeof buildConsentUrl>[0];
}

beforeEach(() => {
  mockGetToken.mockReset();
  mockGenerateAuthUrl.mockReset().mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth?fake=1");
  mockWriteFile.mockReset().mockResolvedValue(undefined);
});

test("buildConsentUrl asks for offline access, the calendar.events scope, and the consent prompt", () => {
  const client = fakeOAuth2Client();

  const url = buildConsentUrl(client);

  expect(url).toBe("https://accounts.google.com/o/oauth2/v2/auth?fake=1");
  expect(mockGenerateAuthUrl).toHaveBeenCalledWith({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    prompt: "consent",
  });
});

test("extractAuthorizationCode returns a bare pasted code unchanged", () => {
  expect(extractAuthorizationCode("4/0Afake-code-value")).toBe("4/0Afake-code-value");
});

test("extractAuthorizationCode trims surrounding whitespace from a bare code", () => {
  expect(extractAuthorizationCode("  4/0Afake-code-value  \n")).toBe("4/0Afake-code-value");
});

test("extractAuthorizationCode pulls the code out of a pasted full redirect URL", () => {
  const pasted = "http://localhost:3000/oauth2callback?code=4%2F0Afake-code&scope=calendar.events";
  expect(extractAuthorizationCode(pasted)).toBe("4/0Afake-code");
});

test("extractAuthorizationCode throws on an empty paste", () => {
  expect(() => extractAuthorizationCode("   ")).toThrow();
});

test("extractAuthorizationCode throws when a pasted URL has no code parameter", () => {
  expect(() => extractAuthorizationCode("http://localhost:3000/oauth2callback?scope=x")).toThrow();
});

test("exchangeAndSaveToken exchanges the code and writes the full token response to the given path", async () => {
  const client = fakeOAuth2Client();
  const tokens = {
    refresh_token: "refresh-abc",
    access_token: "access-abc",
    scope: "https://www.googleapis.com/auth/calendar.events",
    token_type: "Bearer",
    expiry_date: 1234567890,
  };
  mockGetToken.mockResolvedValueOnce({ tokens });

  await exchangeAndSaveToken(client, "fake-code", "/tmp/fake-token.json");

  expect(mockGetToken).toHaveBeenCalledWith("fake-code");
  expect(mockWriteFile).toHaveBeenCalledWith(
    "/tmp/fake-token.json",
    JSON.stringify(tokens, null, 2),
    "utf-8"
  );
});

test("exchangeAndSaveToken throws instead of saving when Google returns no refresh_token", async () => {
  const client = fakeOAuth2Client();
  mockGetToken.mockResolvedValueOnce({ tokens: { access_token: "access-only" } });

  await expect(exchangeAndSaveToken(client, "fake-code", "/tmp/fake-token.json")).rejects.toThrow();
  expect(mockWriteFile).not.toHaveBeenCalled();
});
