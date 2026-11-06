import bcrypt from "bcrypt";
import { createSessionToken } from "./session";

// Re-exported so existing callers that import these from "./auth" (the
// login route, auth.test.ts, route.test.ts) keep working unchanged. See
// session.ts for why these live there instead of here: middleware.ts needs
// them without bcrypt (this file's other dependency) in its module graph.
export { SESSION_COOKIE_NAME, SESSION_DURATION_MS, createSessionToken, verifySessionToken } from "./session";

export async function login(username: string, password: string): Promise<string | null> {
  const expectedUsername = process.env.WEBAPP_USERNAME;
  const expectedPasswordHash = process.env.WEBAPP_PASSWORD_HASH;
  if (!expectedUsername || !expectedPasswordHash) {
    throw new Error("WEBAPP_USERNAME or WEBAPP_PASSWORD_HASH environment variable is not set");
  }

  if (username !== expectedUsername) return null;

  const passwordMatches = await bcrypt.compare(password, expectedPasswordHash);
  if (!passwordMatches) return null;

  return await createSessionToken();
}
