"use client";

import { useEffect } from "react";

// Registers the no-op service worker (public/sw.js) that exists only to
// satisfy the browser's PWA installability check — see that file for why it
// deliberately caches nothing. A failed registration (older browser, an
// extension blocking it) is not worth surfacing to the user: the app works
// fine either way, it just won't offer "Instalar app".
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  return null;
}
