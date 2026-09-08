/*
 * The header's chips (arc 7, D-2). Each one is a fact the server stated on
 * its last answer, never a constant:
 *
 *   - StatusPill — from the health poll and the connection store (shellStatus);
 *   - JudgeChip  — whether the LLM judge is on (health) and, when it is off,
 *                  the server's own steps to enable it (capabilities);
 *   - DemoChip   — health.mode === 'demo'.
 *
 * Every chip is focusable and carries its sentence in a tooltip, so the
 * keyboard reader gets the same explanation as the pointer.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Tooltip } from '../shared/Tooltip';
import type { CapabilitiesSummary, HealthResponse } from '../../api/types';
import { STATUS_COPY, type ShellStatus, type StatusTone } from './shellStatus';

const TONE: Record<StatusTone, { fg: string; bg: string }> = {
  pass: { fg: 'var(--eval-pass)', bg: 'rgba(34, 197, 94, 0.12)' },
  muted: { fg: 'var(--eval-skipped)', bg: 'rgba(148, 163, 184, 0.16)' },
  warn: { fg: 'var(--eval-warn)', bg: 'rgba(245, 158, 11, 0.14)' },
  fail: { fg: 'var(--eval-fail)', bg: 'rgba(239, 68, 68, 0.14)' },
};

const chip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-1_5)',
  padding: '2px var(--space-2)',
  borderRadius: 'var(--radius-pill)',
  fontSize: 'var(--text-caption-xs)',
  fontFamily: 'var(--font-mono)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  cursor: 'default',
};

const dot: CSSProperties = {
  width: '6px',
  height: '6px',
  borderRadius: '50%',
};

const stepList: CSSProperties = {
  margin: '4px 0 0',
  paddingLeft: '1.1em',
  textAlign: 'left',
};

export function StatusPill({ status }: { status: ShellStatus }) {
  const copy = STATUS_COPY[status];
  const tone = TONE[copy.tone];
  return (
    <Tooltip content={copy.sentence}>
      <span
        style={{ ...chip, color: tone.fg, background: tone.bg }}
        data-status={status}
        role="status"
        aria-label={`Connection: ${copy.label}. ${copy.sentence}`}
        tabIndex={0}
      >
        <span style={{ ...dot, background: tone.fg }} aria-hidden="true" />
        {copy.label}
      </span>
    </Tooltip>
  );
}

export function JudgeChip({
  health,
  capabilities,
}: {
  health: HealthResponse | null;
  capabilities: CapabilitiesSummary | null;
}) {
  // Health is polled and wins on state; capabilities is read once and carries the steps.
  const judge = health?.judge ?? capabilities?.judge ?? null;
  if (!judge) return null;
  const provider = judge.provider ?? capabilities?.judge?.provider ?? null;
  const steps = capabilities?.judge?.howToEnable ?? [];
  const on = judge.enabled;
  const label = on ? `judge ${provider ?? 'on'}` : 'judge off';
  const tone = on ? TONE.pass : TONE.muted;
  const content: ReactNode = on ? (
    `The LLM judge is on${provider ? ` (${provider})` : ''}: semantic rules run through it when you evaluate. The key stays on the server.`
  ) : (
    <span>
      The LLM judge is off: semantic rules skip and say so.
      {steps.length > 0 && (
        <>
          {' '}
          To enable it:
          <ol style={stepList}>
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </>
      )}
    </span>
  );
  return (
    <Tooltip content={content}>
      <span
        style={{ ...chip, color: tone.fg, background: tone.bg }}
        data-judge={on ? 'on' : 'off'}
        aria-label={on ? `LLM judge on${provider ? `, ${provider}` : ''}` : 'LLM judge off'}
        tabIndex={0}
      >
        {label}
      </span>
    </Tooltip>
  );
}

export function DemoChip() {
  return (
    <Tooltip content="This server runs on seeded demo data. Nothing here is your traffic, and new traces are not accepted.">
      <span
        style={{ ...chip, color: TONE.warn.fg, background: TONE.warn.bg, letterSpacing: '0.04em' }}
        data-demo="true"
        aria-label="Demo server: seeded data, not your traffic"
        tabIndex={0}
      >
        DEMO
      </span>
    </Tooltip>
  );
}
