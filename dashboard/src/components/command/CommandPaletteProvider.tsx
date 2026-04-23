/*
 * CommandPaletteProvider — global state + keyboard listeners for the
 * command palette and shortcuts overlay.
 *
 * Wraps the app shell (Shell.tsx) so any page can call useCommandPalette()
 * to open it programmatically.
 *
 * Keyboard contract:
 *   - ⌘K (macOS) / Ctrl+K (everywhere): open palette (also intercepts
 *     ⌘P/Ctrl+P which browsers bind to print — we don't bind print,
 *     just K).
 *   - "?" (no modifier, not in an input): open shortcuts overlay.
 *   - Sequence "g <letter>" (no modifier, not in input): jump to the
 *     navigation command bound to that letter (g d → dashboard, g m →
 *     moments, g r → rules, g a → audit, g t → traces, g e → evals).
 *     The 1-second window between "g" and the next key keeps the
 *     interaction tight.
 *
 * Inputs (text fields, textareas, contenteditable) are excluded from
 * single-key shortcut handling — pressing "?" while typing into the rule
 * composer should not pop a modal.
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
import { useNavigate } from 'react-router-dom';
import { CommandPalette } from './CommandPalette';
import { KeyboardShortcutsOverlay } from './KeyboardShortcutsOverlay';

interface CommandPaletteContextValue {
  open: () => void;
  openShortcuts: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

const G_SHORTCUTS: Record<string, string> = {
  d: '/',
  m: '/moments',
  r: '/rules',
  a: '/audit',
  t: '/traces',
  e: '/evals',
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const navigate = useNavigate();

  // "g <letter>" sequence state
  const gPressedAt = useRef<number | null>(null);

  const open = useCallback(() => setPaletteOpen(true), []);
  const close = useCallback(() => setPaletteOpen(false), []);
  const openShortcuts = useCallback(() => {
    setPaletteOpen(false);
    setShortcutsOpen(true);
  }, []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K → open palette (always works, even from inputs)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
        return;
      }

      // Single-key shortcuts only outside text inputs
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      // "g <letter>" navigation sequence
      if (e.key === 'g') {
        gPressedAt.current = Date.now();
        return;
      }
      if (gPressedAt.current && Date.now() - gPressedAt.current < 1000) {
        const dest = G_SHORTCUTS[e.key.toLowerCase()];
        gPressedAt.current = null;
        if (dest) {
          e.preventDefault();
          navigate(dest);
        }
      } else {
        gPressedAt.current = null;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  const value = useMemo(() => ({ open, openShortcuts }), [open, openShortcuts]);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPalette
        open={paletteOpen}
        onClose={close}
        onOpenShortcuts={openShortcuts}
      />
      <KeyboardShortcutsOverlay open={shortcutsOpen} onClose={closeShortcuts} />
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) throw new Error('useCommandPalette must be used inside <CommandPaletteProvider>');
  return ctx;
}
