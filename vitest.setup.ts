import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

// Load .env.test ourselves and write its values into process.env *before*
// anything else in the test process gets a chance to construct a
// PrismaClient. Prisma Client loads the project's .env file on its own the
// moment it's instantiated, but it never overrides a variable that's
// already present in process.env — so setting DATABASE_URL here first is
// what keeps tests pointed at the disposable test database instead of the
// real dev.db.
function loadEnvTestFile(filePath: string) {
  const contents = readFileSync(filePath, "utf-8");
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvTestFile(path.resolve(process.cwd(), ".env.test"));

// DATABASE_URL in .env.test is "file:./test.db", which Prisma resolves
// relative to prisma/schema.prisma, i.e. prisma/test.db.
const testDbPath = path.resolve(process.cwd(), "prisma/test.db");
for (const candidate of [testDbPath, `${testDbPath}-journal`]) {
  if (existsSync(candidate)) rmSync(candidate);
}

// Push the schema onto a fresh file so every test run starts from an empty,
// disposable database instead of the real prisma/dev.db.
execSync("npx prisma db push --skip-generate --accept-data-loss", {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
