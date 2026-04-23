/*
 * AgentList — dashboard Row 3 RIGHT — "AGENTS".
 *
 * Per-agent verdict breakdown. Computes from useMoments (groups
 * moments by agentName, counts verdicts, tracks last activity).
 * Click an agent → /moments?agent={name}.
 *
 * Tiny inline verdict ribbon (pass/partial/fail/unevaluated colored
 * segments) gives at-a-glance distribution without a real chart
 * library.
 */
import { Link } from 'react-router-dom';
import { Users, ChevronRight } from 'lucide-react';
import { useMoments } from '../../api/hooks';
import { Icon } from '../shared/Icon';
import { Tooltip } from '../shared/Tooltip';
import { formatTimeAgo } from '../../utils/formatters';
import type { DecisionMoment } from '../../api/types';

const styles = {
  card: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
  } as const,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'var(--space-3) var(--space-4)',
    borderBottom: '1px solid var(--border-subtle)',
    background: 'var(--bg-surface)',
  } as const,
  title: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-caption)',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  } as const,
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-accent)',
    textDecoration: 'none',
    fontFamily: 'var(--font-mono)',
  } as const,
  list: {
    display: 'flex',
    flexDirection: 'column',
  } as const,
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr auto auto',
    gap: 'var(--space-3)',
    alignItems: 'center',
    padding: 'var(--space-2) var(--space-4)',
    borderBottom: '1px solid var(--border-subtle)',
    color: 'var(--text-primary)',
    textDecoration: 'none',
    fontSize: 'var(--text-body-sm)',
    minHeight: '36px',
    transition: 'background-color var(--transition-fast)',
  } as const,
  agent: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 500,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  ribbon: {
    display: 'inline-flex',
    height: '6px',
    width: '80px',
    borderRadius: 'var(--radius-pill)',
    overflow: 'hidden',
    border: '1px solid var(--border-subtle)',
  } as const,
  meta: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
    minWidth: '64px',
    textAlign: 'right',
  } as const,
  empty: {
    padding: 'var(--space-6) var(--space-4)',
    color: 'var(--text-secondary)',
    fontSize: 'var(--text-body-sm)',
    textAlign: 'center',
  } as const,
};

interface AgentSummary {
  name: string;
  total: number;
  pass: number;
  partial: number;
  fail: number;
  unevaluated: number;
  lastSeen: string;
}

function summarizeAgents(moments: DecisionMoment[]): AgentSummary[] {
  const map = new Map<string, AgentSummary>();
  for (const m of moments) {
    const existing = map.get(m.agentName);
    const summary = existing ?? {
      name: m.agentName,
      total: 0,
      pass: 0,
      partial: 0,
      fail: 0,
      unevaluated: 0,
      lastSeen: m.timestamp,
    };
    summary.total++;
    summary[m.verdict]++;
    if (m.timestamp > summary.lastSeen) summary.lastSeen = m.timestamp;
    map.set(m.agentName, summary);
  }
  return Array.from(map.values()).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

function VerdictRibbon({ summary }: { summary: AgentSummary }) {
  const segments: Array<{ pct: number; color: string; label: string }> = [];
  if (summary.total === 0) return null;
  if (summary.pass > 0)
    segments.push({ pct: (summary.pass / summary.total) * 100, color: 'var(--eval-pass)', label: 'pass' });
  if (summary.partial > 0)
    segments.push({ pct: (summary.partial / summary.total) * 100, color: 'var(--eval-warn)', label: 'partial' });
  if (summary.fail > 0)
    segments.push({ pct: (summary.fail / summary.total) * 100, color: 'var(--eval-fail)', label: 'fail' });
  if (summary.unevaluated > 0)
    segments.push({
      pct: (summary.unevaluated / summary.total) * 100,
      color: 'var(--text-muted)',
      label: 'unevaluated',
    });
  return (
    <Tooltip
      content={`${summary.pass} pass · ${summary.partial} partial · ${summary.fail} fail · ${summary.unevaluated} unevaluated`}
    >
      <span style={styles.ribbon} tabIndex={0} aria-label="Verdict distribution">
        {segments.map((s) => (
          <span
            key={s.label}
            style={{
              width: `${s.pct}%`,
              background: s.color,
              display: 'inline-block',
              height: '100%',
            }}
            aria-hidden="true"
          />
        ))}
      </span>
    </Tooltip>
  );
}

export function AgentList() {
  // Pull a generous slice of moments so the per-agent summary covers
  // recent activity well. Polling reuses the existing 5s cadence.
  const { data, loading } = useMoments({ limit: '200' });
  const agents = data ? summarizeAgents(data.moments) : [];

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.title}>
          <Icon as={Users} size={14} />
          Agents <span style={{ color: 'var(--text-muted)' }}>· {agents.length}</span>
        </div>
        <Link to="/traces" style={styles.link}>
          Compare <Icon as={ChevronRight} size={14} />
        </Link>
      </div>

      <div style={styles.list}>
        {loading && !data && <div style={styles.empty}>Loading…</div>}
        {!loading && agents.length === 0 && (
          <div style={styles.empty}>
            No agents have logged traces yet. Run any MCP-compatible agent against
            <code style={{ background: 'var(--bg-surface)', padding: '0 4px', borderRadius: '3px', margin: '0 4px' }}>npx @iris-eval/mcp-server</code>
            and they'll appear here.
          </div>
        )}
        {agents.map((agent) => (
          <Link
            key={agent.name}
            to={`/moments?agent=${encodeURIComponent(agent.name)}`}
            style={styles.row}
            title={`Open ${agent.name} moments`}
          >
            <span style={styles.agent}>{agent.name}</span>
            <VerdictRibbon summary={agent} />
            <Tooltip content={`Last activity at ${new Date(agent.lastSeen).toLocaleString()}`}>
              <span style={styles.meta} tabIndex={0}>
                {agent.total} · {formatTimeAgo(agent.lastSeen)}
              </span>
            </Tooltip>
          </Link>
        ))}
      </div>
    </div>
  );
}
