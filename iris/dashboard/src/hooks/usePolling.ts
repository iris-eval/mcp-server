import { useEffect, useRef } from 'react';

export function usePolling(callback: () => void, intervalMs?: number): void {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    if (!intervalMs) return;

    const tick = () => {
      if (document.visibilityState === 'visible') {
        savedCallback.current();
      }
    };

    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
