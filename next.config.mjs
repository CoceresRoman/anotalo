/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required on Next.js 14.x for src/instrumentation.ts's register() to run
  // (starts the WhatsApp connection once per server process). Stable by
  // default starting in Next.js 15 — this flag can be dropped on upgrade.
  experimental: {
    instrumentationHook: true,
    // Without this, webpack bundles @whiskeysockets/baileys (and its `ws`
    // dependency) into the server bundle instead of letting Node require()
    // it from node_modules at runtime. That breaks ws's optional native
    // bufferutil addon (observed real symptom: every connection attempt
    // fails immediately with "bufferUtil.mask is not a function", which
    // this task's own reconnect backoff then dutifully retries forever) —
    // marking it external keeps native-addon resolution working.
    serverComponentsExternalPackages: ["@whiskeysockets/baileys"],
  },
};

export default nextConfig;
