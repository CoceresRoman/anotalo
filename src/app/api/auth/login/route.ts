import { NextRequest, NextResponse } from "next/server";
import { login, SESSION_COOKIE_NAME, SESSION_DURATION_MS } from "../../../../lib/auth";
import { checkLoginRateLimit } from "../../../../lib/rateLimit";

const SESSION_COOKIE_MAX_AGE_SECONDS = SESSION_DURATION_MS / 1000;

export async function POST(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ip = forwardedFor?.split(",")[0]?.trim() || request.ip || "unknown";

  if (!checkLoginRateLimit(ip)) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }

  const { username, password } = await request.json();
  const token = await login(username, password);

  if (!token) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true }, { status: 200 });
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
