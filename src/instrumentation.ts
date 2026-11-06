// Next.js instrumentation hook: register() runs once when the server
// process starts (see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation).
// This is where the WhatsApp connection gets started, since it needs to run
// exactly once per server process, independent of any particular request.
//
// Baileys depends on Node-only APIs (native crypto, filesystem auth state,
// and transitively sharp/libsignal, which touch fs/child_process), so this
// must never run — and must never even be bundled — under the Edge runtime.
// Next.js compiles instrumentation.ts once per runtime (nodejs and edge);
// the corrective fix in Task 2b hit a very similar Node-vs-Edge mismatch in
// src/lib/session.ts. This time the risk is at build time, not just
// runtime: webpack's edge compiler statically resolves whatever an
// `import()` reaches, so the dynamic import MUST stay inside a direct
// `if (process.env.NEXT_RUNTIME === "nodejs") { ... }` block (not behind an
// early return) — DefinePlugin substitutes NEXT_RUNTIME as a literal per
// compiler pass, and webpack's parser only drops a branch's dependencies
// (skipping resolution of @whiskeysockets/baileys entirely for the edge
// bundle) when the condition is a literal `if`, the same mechanism that lets
// `if (process.env.NODE_ENV === "production")` dev-only requires disappear
// from production bundles without a minifier.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWhatsAppConnection } = await import("./lib/whatsapp/connection");
    // router.ts transitively imports connection.ts, classify.ts (groq-sdk)
    // and db — all Node-only — so this import must stay inside the same
    // literal `if (process.env.NEXT_RUNTIME === "nodejs")` block as the one
    // above, for the same webpack-edge-bundling reason documented atop this
    // file.
    const { handleIncomingMessage } = await import("./lib/whatsapp/router");
    // A startup-time failure here (e.g. an unwritable .wa-auth dir, or
    // makeWASocket throwing) must not propagate out of register() unhandled
    // — that would crash server startup entirely. The recursive reconnect
    // call inside connection.ts already guards itself the same way; this is
    // the equivalent guard for the very first call.
    try {
      await startWhatsAppConnection(handleIncomingMessage);
    } catch (err) {
      console.error("[whatsapp] failed to start the WhatsApp connection", err);
    }
  }
}
