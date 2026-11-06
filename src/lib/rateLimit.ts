// In-memory sliding-window rate limiter for login attempts. Single-process
// personal app (no horizontal scaling), so a Map in memory is sufficient —
// no need for Redis or a DB-backed limiter.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

const attemptsByIp = new Map<string, number[]>();

// This is a login route on the public internet, so every distinct IP that
// ever hits it (scanners included) needs to eventually be forgotten, even
// one that only calls once and never comes back — otherwise the Map grows
// without bound for the life of the process. Pruning a single IP's own
// array on its next call isn't enough for that case (an IP that never
// calls again never gets its own entry revisited), so this sweeps *every*
// key on each call and drops ones with no timestamps left in the window.
// Lazy (triggered by any call, not a timer), so there's nothing to manage.
function pruneStaleEntries(now: number) {
  const windowStart = now - WINDOW_MS;
  // .forEach() rather than for...of, since this project's TS target doesn't
  // have downlevelIteration enabled for iterating a Map directly.
  attemptsByIp.forEach((timestamps, ip) => {
    const stillRecent = timestamps.filter((timestamp: number) => timestamp > windowStart);
    if (stillRecent.length === 0) {
      attemptsByIp.delete(ip);
    } else if (stillRecent.length !== timestamps.length) {
      attemptsByIp.set(ip, stillRecent);
    }
  });
}

export function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  pruneStaleEntries(now);

  const recentAttempts = attemptsByIp.get(ip) ?? [];

  if (recentAttempts.length >= MAX_ATTEMPTS) {
    return false;
  }

  recentAttempts.push(now);
  attemptsByIp.set(ip, recentAttempts);
  return true;
}
