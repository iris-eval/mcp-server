/*
 * ExportMenu — download every row a list page's filters admit (#4).
 *
 * Every page of the list, not the page on screen: the links point at the
 * server's streaming export (GET /api/v1/{traces,evaluations}/export) with
 * the page's own filters and search, so a hundred thousand rows go
 * straight from the server to the browser's download manager without
 * being held in this tab. A plain link is also why the download works
 * with an --api-key dashboard: the browser sends the session cookie with
 * it as with any page.
 *
 * A disclosure, not an ARIA menu: a button that shows two links. Escape
 * and a click elsewhere close it; Escape returns focus to the button.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Icon } from './Icon';
import { API_BASE_URL } from '../../utils/constants';

export type ExportKind = 'traces' | 'evaluations';
export type ExportFormat = 'csv' | 'jsonl';

/** The export URL for a list's filters: the same parameters the list sends, without the page. */
export function exportHref(kind: ExportKind, filters: Record<string, string>, format: ExportFormat): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'limit' || key === 'offset' || value === '') continue;
    params.set(key, value);
  }
  params.set('format', format);
  return `${API_BASE_URL}/${kind}/export?${params.toString()}`;
}

const styles = {
  wrap: {
    position: 'relative',
    display: 'inline-block',
  } as const,
  trigger: {
    appearance: 'none',
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--space-2) var(--space-3)',
    fontSize: 'var(--text-body-sm)',
    fontFamily: 'inherit',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1_5)',
    transition: 'background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast)',
  } as const,
  triggerDisabled: {
    cursor: 'not-allowed',
    opacity: 0.6,
  } as const,
  panel: {
    position: 'absolute',
    top: 'calc(100% + var(--space-2))',
    right: 0,
    width: '300px',
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-lg)',
    zIndex: 50,
    padding: 'var(--space-2)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
  } as const,
  note: {
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
    padding: 'var(--space-1) var(--space-2)',
    margin: 0,
  } as const,
  link: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: 'var(--space-2)',
    borderRadius: 'var(--radius-xs)',
    color: 'var(--text-primary)',
    textDecoration: 'none',
    fontSize: 'var(--text-body-sm)',
  } as const,
  linkHint: {
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
  } as const,
};

const FORMATS: Array<{ format: ExportFormat; label: string; hint: string }> = [
  { format: 'csv', label: 'CSV', hint: 'For Excel, Sheets and Numbers' },
  { format: 'jsonl', label: 'JSON Lines', hint: 'One record per line, for scripts' },
];

export interface ExportMenuProps {
  kind: ExportKind;
  /** The list's current filters and search, as it sends them; limit and offset are ignored. */
  filters: Record<string, string>;
  /** How many rows the filters match, when the list knows; 0 disables the button. */
  total?: number;
}

export function ExportMenu({ kind, filters, total }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const noun = kind === 'traces' ? (total === 1 ? 'trace' : 'traces') : total === 1 ? 'evaluation' : 'evaluations';
  const empty = total === 0;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={styles.wrap} data-export={kind}>
      <button
        ref={triggerRef}
        type="button"
        style={{ ...styles.trigger, ...(empty ? styles.triggerDisabled : {}) }}
        aria-expanded={open}
        // The panel exists only while open; a reference to a missing id names nothing.
        aria-controls={open ? panelId : undefined}
        disabled={empty}
        title={empty ? `No ${kind} match these filters` : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon as={Download} size={14} />
        {total === undefined ? `Export ${kind}` : `Export ${total.toLocaleString()} ${noun}`}
      </button>
      {open && (
        <div id={panelId} role="group" aria-label={`Export ${kind}`} style={styles.panel} onClick={(e) => e.stopPropagation()}>
          <p style={styles.note}>
            Every {kind === 'traces' ? 'trace' : 'evaluation'} that matches the current filters{kind === 'traces' ? ' and search' : ''}, across all
            pages, with its full stored text.
          </p>
          {FORMATS.map((f) => (
            <a
              key={f.format}
              href={exportHref(kind, filters, f.format)}
              download
              style={styles.link}
              data-export-format={f.format}
              onClick={() => setOpen(false)}
            >
              <span>{f.label}</span>
              <span style={styles.linkHint}>{f.hint}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
