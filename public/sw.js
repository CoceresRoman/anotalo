// Service worker with no caching on purpose: this app shows live financial
// data (saldo, gastos, cuotas), so serving a cached response instead of a
// fresh one would show the user a stale balance. Its only job is to have a
// `fetch` listener at all — that's one of the installability requirements
// Chrome/Android checks before offering "Instalar app".
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
