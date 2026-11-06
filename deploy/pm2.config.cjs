// pm2 process manager config for notas-whatsapp. Run from the repo root with:
//
//   pm2 start deploy/pm2.config.cjs
//
// See deploy/README.md for the full one-time VM setup this fits into.
module.exports = {
  apps: [
    {
      name: "notas-whatsapp",
      // Delegates to the project's own "start" script (`next start`) rather
      // than invoking `next` directly, so this config stays correct even if
      // package.json's start script ever grows extra setup steps.
      script: "npm",
      // Everything after `--` is forwarded by npm to the underlying
      // `next start` command (this is plain npm behavior, not pm2-specific).
      //
      // `-H 127.0.0.1` is NOT optional: the app must be reachable only via
      // Caddy's reverse proxy (deploy/Caddyfile), never directly from the
      // internet. The login route's per-IP rate limiter
      // (src/lib/rateLimit.ts, used by src/app/api/auth/login/route.ts)
      // trusts the `x-forwarded-for` request header to identify the
      // caller's IP. That header is only trustworthy when Caddy is the one
      // and only thing allowed to set it — i.e. when the Next.js process
      // itself is unreachable from outside the VM. Binding to 0.0.0.0 would
      // let any internet client hit port 3000 directly and forge its own
      // `x-forwarded-for`, defeating the rate limiter entirely.
      //
      // `-p 3000` matches the port deploy/Caddyfile reverse-proxies to.
      args: "start -- -H 127.0.0.1 -p 3000",
      // "npm" is a shell script/binary, not a Node script — tell pm2 not to
      // run it through the Node interpreter.
      interpreter: "none",
      // Resolves to the repo root (this file lives in deploy/) regardless
      // of which user/home directory the repo was cloned into on the VM.
      cwd: __dirname + "/..",
      autorestart: true,
      // Caps restart-storm speed if the app is crash-looping (e.g. a bad
      // .env) instead of pm2 respawning it as fast as it can crash.
      restart_delay: 5000,
      max_restarts: 20,
      // This is a long-running server process, not a dev watch loop.
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      // No env_file / explicit secrets here on purpose: Next.js's own CLI
      // loads the project's .env file automatically on every `next start`
      // (confirmed by the "Environments: .env" line Next prints at
      // build/start time) as long as pm2's `cwd` above is the project root
      // containing that .env — which it is. So SESSION_SECRET,
      // WEBAPP_USERNAME, WEBAPP_PASSWORD_HASH, DATABASE_URL, GROQ_API_KEY,
      // and the GOOGLE_* vars all reach the process without pm2 having to
      // repeat them (and without them ending up readable via `pm2 env` or
      // `pm2 jlist`, which plain pm2 `env:{}` values would be).
      //
      // Deliberately no out_file/error_file override: pm2's default log
      // files (under ~/.pm2/logs/) are exactly what `pm2 logs
      // notas-whatsapp` tails, which is how the WhatsApp pairing QR
      // (printed by Baileys on first boot) gets read — see
      // deploy/README.md.
    },
  ],
};
