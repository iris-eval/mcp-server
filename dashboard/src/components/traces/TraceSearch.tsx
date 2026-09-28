import { useEffect, useId, useRef, useState } from 'react';

/*
 * The trace list's search box (#7).
 *
 * It edits a draft and commits it after a short pause in typing, so a query
 * is sent per phrase rather than per keystroke; Enter commits at once and
 * Escape clears. The committed value lives in the page's URL (?q=), so a
 * search can be linked, reloaded and left with the back button.
 *
 * The server reads any text as words (quotes, stars and parentheses are
 * never query syntax) and refuses a query with no word in it, and one with
 * a prefix too short to narrow anything (#703); the box checks both first,
 * so typing "(" or "re*" shows a hint instead of an error. The server's
 * other limits (how many terms) come back as its own message.
 */
export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MAX_LENGTH = 500;
/** The server's SEARCH_MIN_PREFIX_CHARS (src/storage/search.ts); a test holds the two equal. */
export const SEARCH_MIN_PREFIX_CHARS = 3;

/** Whether the text has anything the server can search: a letter or a digit. */
export function hasSearchableWord(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

const CJK_RE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\u3005\u30fc]/u;

/**
 * The prefixes the server would refuse as too short: a word written
 * straight before the `*` that ends a word (or before the closing quote of
 * a phrase the `*` follows) with fewer than SEARCH_MIN_PREFIX_CHARS letters
 * or digits, and no Chinese, Japanese or Korean in it, where one character
 * is enough. A `*` inside a word is punctuation, not a prefix.
 */
export function shortPrefixes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/([\p{L}\p{N}\p{M}]+)"?\*+(?=[\s"]|$)/gu)) {
    const word = m[1];
    if (!CJK_RE.test(word) && Array.from(word.replace(/\p{M}/gu, '')).length < SEARCH_MIN_PREFIX_CHARS) out.push(`${word}*`);
  }
  return out;
}

const styles = {
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    flex: '1 1 280px',
    minWidth: '220px',
    maxWidth: '520px',
  } as const,
  input: {
    padding: 'var(--space-2) var(--space-3)',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-size-sm)',
    width: '100%',
  } as const,
  hint: {
    color: 'var(--text-muted)',
    fontSize: 'var(--font-size-xs)',
  } as const,
};

export function TraceSearch({ value, onCommit }: { value: string; onCommit: (q: string) => void }) {
  const [draft, setDraft] = useState(value);
  const hintId = useId();
  const committed = useRef(value);

  // The URL changed from outside the box (back button, a pasted link): show what it says.
  useEffect(() => {
    committed.current = value;
    setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    if (next === committed.current) return;
    committed.current = next;
    onCommit(next);
  };

  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(() => commit(draft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // commit reads the ref and the latest onCommit; the draft is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  return (
    <form
      role="search"
      aria-label="Trace search"
      style={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        commit(draft);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="search"
        style={styles.input}
        value={draft}
        maxLength={SEARCH_MAX_LENGTH}
        placeholder="Search input, output, tool calls, metadata, spans…"
        aria-label="Search traces"
        aria-describedby={hintId}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && draft !== '') {
            e.preventDefault();
            setDraft('');
            commit('');
          }
        }}
      />
      <span id={hintId} style={styles.hint}>
        Every word must appear. &quot;Quoted phrase&quot; for exact order, word* for a prefix.
      </span>
    </form>
  );
}
