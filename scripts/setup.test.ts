import bcrypt from "bcrypt";
import { expect, test } from "vitest";

import { buildEnvFileContent, generateSessionSecret, hashPassword } from "./setup";

test("generateSessionSecret returns a 64-char hex string, different each call", () => {
  const a = generateSessionSecret();
  const b = generateSessionSecret();
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(a).not.toBe(b);
});

test("hashPassword produces a hash bcrypt.compare accepts", async () => {
  const hash = await hashPassword("algo");
  expect(await bcrypt.compare("algo", hash)).toBe(true);
});

test("buildEnvFileContent sets the 3 generated values with no prior .env", () => {
  const out = buildEnvFileContent({ username: "u", passwordHash: "h", sessionSecret: "s" });
  expect(out).toContain("WEBAPP_USERNAME=u");
  expect(out).toContain("WEBAPP_PASSWORD_HASH=h");
  expect(out).toContain("SESSION_SECRET=s");
});

test("buildEnvFileContent preserves unrelated existing lines", () => {
  const out = buildEnvFileContent(
    { username: "u", passwordHash: "h", sessionSecret: "s" },
    "GROQ_API_KEY=existing-value\n"
  );
  expect(out).toContain("GROQ_API_KEY=existing-value");
});

test("buildEnvFileContent replaces existing WEBAPP_USERNAME/WEBAPP_PASSWORD_HASH/SESSION_SECRET lines in place, without duplicating them, on a re-run", () => {
  const existingEnv = [
    "GROQ_API_KEY=existing-value",
    "WEBAPP_USERNAME=old-user",
    "DATABASE_URL=file:./prod.db",
    "WEBAPP_PASSWORD_HASH=old-hash",
    "SESSION_SECRET=old-secret",
    "",
  ].join("\n");

  const out = buildEnvFileContent(
    { username: "new-user", passwordHash: "new-hash", sessionSecret: "new-secret" },
    existingEnv
  );

  // Unrelated lines are untouched, and keep their original position.
  expect(out).toContain("GROQ_API_KEY=existing-value");
  expect(out).toContain("DATABASE_URL=file:./prod.db");

  // The 3 managed lines are updated in place, not duplicated.
  expect(out.match(/^WEBAPP_USERNAME=/gm)).toHaveLength(1);
  expect(out.match(/^WEBAPP_PASSWORD_HASH=/gm)).toHaveLength(1);
  expect(out.match(/^SESSION_SECRET=/gm)).toHaveLength(1);
  expect(out).toContain("WEBAPP_USERNAME=new-user");
  expect(out).toContain("WEBAPP_PASSWORD_HASH=new-hash");
  expect(out).toContain("SESSION_SECRET=new-secret");
  expect(out).not.toContain("old-user");
  expect(out).not.toContain("old-hash");
  expect(out).not.toContain("old-secret");

  // Order of the untouched lines relative to each other is preserved.
  const lines = out.split("\n").filter(Boolean);
  expect(lines.indexOf("GROQ_API_KEY=existing-value")).toBeLessThan(
    lines.indexOf("DATABASE_URL=file:./prod.db")
  );
});
