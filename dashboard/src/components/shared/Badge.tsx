// The red text is #ef4444 lifted to 4.5:1 on its #450a0a fill.
const colorMap: Record<string, { bg: string; fg: string }> = {
  OK: { bg: '#052e16', fg: '#22c55e' },
  ERROR: { bg: '#450a0a', fg: '#f44948' },
  UNSET: { bg: '#27272a', fg: '#a1a1aa' },
  LLM: { bg: '#2e1065', fg: '#a855f7' },
  TOOL: { bg: '#172554', fg: '#3b82f6' },
  INTERNAL: { bg: '#27272a', fg: '#a1a1aa' },
  SERVER: { bg: '#164e63', fg: '#22d3ee' },
  CLIENT: { bg: '#422006', fg: '#f59e0b' },
  pass: { bg: '#052e16', fg: '#22c55e' },
  fail: { bg: '#450a0a', fg: '#f44948' },
  // Not checked: neither colour of a result.
  unknown: { bg: '#27272a', fg: '#a1a1aa' },
};

export function Badge({ label, variant }: { label: string; variant?: string }) {
  const colors = colorMap[variant ?? label] ?? colorMap.UNSET;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 'var(--border-radius-sm)',
        fontSize: 'var(--font-size-xs)',
        fontWeight: 500,
        background: colors.bg,
        color: colors.fg,
      }}
    >
      {label}
    </span>
  );
}
