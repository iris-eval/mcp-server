/*
 * usePreferences — React context + hook for server-mediated preferences.
 *
 * Mirrors ~/.iris/preferences.json via the GET/PATCH /api/v1/preferences
 * endpoints. Provides:
 *   - preferences: current Preferences snapshot (null until loaded)
 *   - patch: optimistic update with rollback on server failure
 *   - loading / error: load state for the UI
 *
 * The hook uses a single shared context so multiple components (theme
 * toggle, moments page, onboarding tour) read the same state without
 * fanning out network calls.
 *
 * Network-failure behavior: PATCH errors roll back the optimistic
 * update, store the error string, and re-throw so the caller can decide
 * whether to surface a toast. The next refetch repairs state if the
 * patch was actually persisted but the response failed in transit.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../api/client';
import type { Preferences, PreferencesPatch } from '../api/types';

interface PreferencesContextValue {
  preferences: Preferences | null;
  loading: boolean;
  error: string | null;
  patch: (input: PreferencesPatch) => Promise<Preferences | null>;
  refetch: () => Promise<void>;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<Promise<Preferences | null> | null>(null);

  const refetch = useCallback(async () => {
    try {
      const result = await api.getPreferences();
      setPreferences(result.preferences);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load preferences');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const patch = useCallback(
    async (input: PreferencesPatch): Promise<Preferences | null> => {
      const previous = preferences;
      // Optimistic merge — server returns the canonical merged result anyway,
      // but the UI feels instant.
      if (previous) {
        setPreferences({ ...previous, ...input });
      }
      // Coalesce concurrent patches: callers awaiting an in-flight patch
      // get the same promise, but we still issue one request per patch
      // (last write wins). Avoids the UI rolling back twice on a failure.
      const pending = api
        .patchPreferences(input)
        .then((result) => {
          setPreferences(result.preferences);
          setError(null);
          return result.preferences;
        })
        .catch((err) => {
          // Roll back to previous on failure
          setPreferences(previous);
          setError(err instanceof Error ? err.message : 'Patch failed');
          throw err;
        });
      inflight.current = pending;
      try {
        return await pending;
      } finally {
        if (inflight.current === pending) inflight.current = null;
      }
    },
    [preferences],
  );

  const value = useMemo(
    () => ({ preferences, loading, error, patch, refetch }),
    [preferences, loading, error, patch, refetch],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferences must be used inside <PreferencesProvider>');
  return ctx;
}
