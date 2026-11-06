"use client";

import { useEffect, useRef } from "react";

// Re-runs `callback` whenever the tab becomes visible again — the case this
// exists for: the user sends a WhatsApp message, then switches back to this
// already-open page and expects the new gasto/ingreso/recordatorio/idea to
// show up without a manual reload. `visibilitychange` (not `focus`) is the
// right event for that: it fires on tab switches and on mobile when the PWA
// comes back to the foreground, which is exactly this scenario.
//
// The callback is read through a ref so callers can pass a fresh closure on
// every render without needing to memoize it themselves; the listener is
// still only registered once.
export function useRefetchOnFocus(callback: () => void): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        callbackRef.current();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);
}
