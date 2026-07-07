"use client";

import { useRef, useCallback } from "react";

export function usePlaygroundAnalytics() {
  const tracked = useRef(new Set<string>());

  const track = useCallback((event: string, data?: Record<string, string | number>) => {
    if (tracked.current.has(event)) return;
    tracked.current.add(event);
    if (typeof window === "undefined") return;
    const va = (window as Window & { va?: (kind: string, payload: Record<string, unknown>) => void }).va;
    if (va) {
      va("event", { name: event, ...data });
    }
  }, []);

  return { track };
}
