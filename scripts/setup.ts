// One-time interactive CLI: generates a fresh ./.env for a new clone of this
// repo. Asks for the webapp username and password, then writes/updates the
// three secrets the app actually needs to run:
//
//   WEBAPP_USERNAME      — read in src/lib/auth.ts
//   WEBAPP_PASSWORD_HASH — a bcrypt hash of the chosen password, also read
//                          in src/lib/auth.ts (the plaintext password is
//                          never written anywhere)
//   SESSION_SECRET       — a random secret used to sign session cookies,
//                          read in src/lib/session.ts
//
// Run once (or again, to rotate these 3 values) with:
//
//   npx tsx scripts/setup.ts
//
// Any other variable already in .env (GROQ_API_KEY, GOOGLE_CLIENT_ID, the
// DATABASE_URL, ...) is left untouched — see .env.example for the full list
// this app needs.
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import bcrypt from "bcrypt";

const ENV_PATH = path.resolve(process.cwd(), ".env");

const MANAGED_ENV_KEYS = ["WEBAPP_USERNAME", "WEBAPP_PASSWORD_HASH", "SESSION_SECRET"] as const;

export function generateSessionSecret(): string {
  return randomBytes(32).toString("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

// Builds the full contents of the .env file given the 3 generated values and
// (optionally) the current contents of an existing .env. When re-run against
// an .env that already has WEBAPP_USERNAME/WEBAPP_PASSWORD_HASH/SESSION_SECRET
// lines, those 3 lines are replaced in place (never duplicated) and every
// other line (comments, GROQ_API_KEY, GOOGLE_CLIENT_ID, ...) is preserved as-is.
export function buildEnvFileContent(
  answers: { username: string; passwordHash: string; sessionSecret: string },
  existingEnv?: string
): string {
  const values: Record<string, string> = {
    WEBAPP_USERNAME: answers.username,
    WEBAPP_PASSWORD_HASH: answers.passwordHash,
    SESSION_SECRET: answers.sessionSecret,
  };

  const existingLines = existingEnv ? existingEnv.split("\n") : [];
  // split("\n") on a string ending in "\n" leaves a trailing "" entry — drop
  // it, since we add the final newline back ourselves below.
  if (existingLines.length > 0 && existingLines[existingLines.length - 1] === "") {
    existingLines.pop();
  }

  const seen = new Set<string>();
  const outputLines: string[] = [];

  for (const line of existingLines) {
    const eqIndex = line.indexOf("=");
    const key = eqIndex === -1 ? null : line.slice(0, eqIndex).trim();
    if (key && Object.prototype.hasOwnProperty.call(values, key)) {
      outputLines.push(`${key}=${values[key]}`);
      seen.add(key);
    } else {
      outputLines.push(line);
    }
  }

  for (const key of MANAGED_ENV_KEYS) {
    if (!seen.has(key)) {
      outputLines.push(`${key}=${values[key]}`);
    }
  }

  return outputLines.join("\n") + "\n";
}

async function readExistingEnv(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let username: string;
  let password: string;
  try {
    username = await rl.question("Usuario para entrar a la webapp: ");
    password = await rl.question("Contraseña para entrar a la webapp: ");
  } finally {
    rl.close();
  }

  if (!username.trim() || !password) {
    console.error("El usuario y la contraseña no pueden estar vacíos.");
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);
  const sessionSecret = generateSessionSecret();

  const existingEnv = await readExistingEnv(ENV_PATH);
  const envContent = buildEnvFileContent(
    { username: username.trim(), passwordHash, sessionSecret },
    existingEnv
  );
  await writeFile(ENV_PATH, envContent, "utf-8");

  console.log(`\nListo. Se ${existingEnv ? "actualizó" : "creó"} ${ENV_PATH} con:`);
  console.log("  - WEBAPP_USERNAME");
  console.log("  - WEBAPP_PASSWORD_HASH (hash bcrypt de tu contraseña, nunca el texto plano)");
  console.log("  - SESSION_SECRET (nuevo, aleatorio)");
  console.log("\nPróximos pasos:");
  console.log("  1. Completá en .env el resto de las variables (ver .env.example): GROQ_API_KEY,");
  console.log("     DATABASE_URL y, si vas a usar Google Calendar, GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.");
  console.log("     Si no vivís en Argentina, no usás pesos o no hablás español, mirá también");
  console.log("     DEFAULT_CURRENCY/APP_TIMEZONE/APP_UTC_OFFSET/BOT_LOCALE en .env.example — ya");
  console.log("     tienen defaults razonables, así que podés dejarlos si no te hacen falta.");
  console.log("  2. Corré las migraciones de la base: npx prisma migrate deploy");
  console.log("  3. Arrancá el bot y escaneá el QR de WhatsApp que va a imprimir en la consola.");
}

// Only runs the interactive flow when this file is executed directly (e.g.
// `npx tsx scripts/setup.ts`), not when its exported helpers are imported
// for testing.
if (process.argv[1] && process.argv[1].endsWith("setup.ts")) {
  main().catch((err) => {
    console.error("setup failed:", err);
    process.exitCode = 1;
  });
}
