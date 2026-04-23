/*
 * DensitySync — apply preferences.density to <html data-density>.
 *
 * Mirrors ThemeProvider's applyTheme pattern but sources state from the
 * server-mediated preferences API so density persists across sessions
 * and syncs across browser tabs (via the next fetch).
 *
 * Mounts inside PreferencesProvider and renders nothing.
 */
import { useEffect } from 'react';
import { usePreferences } from '../../hooks/usePreferences';

export function DensitySync(): null {
  const { preferences } = usePreferences();

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const density = preferences?.density ?? 'compact';
    document.documentElement.setAttribute('data-density', density);
  }, [preferences?.density]);

  return null;
}
