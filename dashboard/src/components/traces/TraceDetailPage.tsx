/*
 * TraceDetailPage — single trace surface.
 *
 * The chrome already renders h1 "Trace" from routeTitles. This page adds
 * the resource-specific summary card + semantic sections wrapped in
 * <section aria-labelledby> so AT users can navigate by structure.
 *
 * Labels on the user's own traffic live here too: every fired
 * rule on every evaluation card carries a right/wrong control, the page
 * keeps the labels it has read and written, and each card can re-score its
 * trace under the rules and labels as they stand now.
 */
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router';
import { useTraceDetail, useBuiltInRules, useCapabilities } from '../../api/hooks';
import { api } from '../../api/client';
import type { VerdictLabelValue } from '../../api/types';
import { QueryError } from '../shared/QueryError';
import { SpanTree } from './SpanTree';
import { SessionStrip } from './SessionStrip';
import { ToolCallCard } from './ToolCallCard';
import { EvalDetailCard } from '../evals/EvalDetailCard';
import { labelSentence, reevaluateSentence } from '../evals/labelText';
import { Badge } from '../shared/Badge';
import { LatencyDisplay } from '../shared/LatencyDisplay';
import { CostDisplay } from '../shared/CostDisplay';
import { CopyableId } from '../shared/CopyableId';
import { JsonViewer } from '../shared/JsonViewer';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { EmptyState } from '../shared/EmptyState';

/* Static styling lives in utilities.css (.detail-* block). */

type LabelsByEval = Record<string, Record<string, VerdictLabelValue>>;

export function TraceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, refetch } = useTraceDetail(id!);
  // The rule roster and the published table, read once each: the row's definition and interval.
  const rules = useBuiltInRules();
  const capabilities = useCapabilities();

  // Labels on this trace's evaluations: read once per evaluation, kept on the page after a write.
  const [labels, setLabels] = useState<LabelsByEval>({});
  const [labelBusy, setLabelBusy] = useState(false);
  const [labelNotes, setLabelNotes] = useState<Record<string, string>>({});
  const [reevaluating, setReevaluating] = useState<string | null>(null);
  const [reevaluateNotes, setReevaluateNotes] = useState<Record<string, string>>({});
  const evalIdsKey = (data?.evals ?? []).map((e) => e.id).join(',');

  useEffect(() => {
    if (evalIdsKey === '') return;
    let cancelled = false;
    void (async () => {
      const next: LabelsByEval = {};
      for (const evalId of evalIdsKey.split(',')) {
        try {
          const { labels: rows } = await api.getLabels(evalId);
          next[evalId] = Object.fromEntries(rows.filter((l) => l.ruleName !== null).map((l) => [l.ruleName as string, l.label]));
        } catch {
          // A page whose labels could not be read still renders; the control writes on first use.
        }
      }
      if (!cancelled) setLabels(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [evalIdsKey]);

  const onLabel = async (evalId: string, rule: string, label: VerdictLabelValue) => {
    setLabelBusy(true);
    try {
      const r = await api.labelRule(evalId, rule, label);
      setLabels((m) => ({ ...m, [evalId]: { ...(m[evalId] ?? {}), [rule]: label } }));
      setLabelNotes((m) => ({ ...m, [evalId]: labelSentence(r) }));
    } catch (err) {
      setLabelNotes((m) => ({ ...m, [evalId]: `Could not save the label: ${err instanceof Error ? err.message : String(err)}` }));
    } finally {
      setLabelBusy(false);
    }
  };

  const onReevaluate = async (evalId: string) => {
    setReevaluating(evalId);
    try {
      const r = await api.reevaluate(evalId);
      setReevaluateNotes((m) => ({ ...m, [evalId]: reevaluateSentence(r) }));
      refetch();
    } catch (err) {
      setReevaluateNotes((m) => ({ ...m, [evalId]: `Could not re-score: ${err instanceof Error ? err.message : String(err)}` }));
    } finally {
      setReevaluating(null);
    }
  };

  if (loading) return <LoadingSpinner />;
  if (error) return <QueryError error={error} what="this trace" onRetry={refetch} />;
  if (!data) return <EmptyState message="Trace not found" />;

  const { trace, spans, evals } = data;
  const rulesByName = new Map((rules.data ?? []).map((r) => [r.name, r]));
  const proofsByName = new Map(
    (capabilities.data?.rules ?? []).flatMap((r) => (r.proof ? [[r.name, r.proof] as const] : [])),
  );
  const questionText = new Map((capabilities.data?.questions ?? []).map((q) => [q.id, q.text]));

  return (
    <div className="iris-stack iris-stack--lg">
      <Link to="/traces" className="detail-back">&larr; Back to traces</Link>

      <section aria-labelledby="trace-summary-title" className="iris-card detail-card">
        <h2
          id="trace-summary-title"
          className="detail-card__label"
          style={{ marginBottom: 'var(--space-3)' }}
        >
          Trace summary
        </h2>
        <div className="detail-card__grid">
          <div>
            <span className="detail-card__label">Trace ID</span><br />
            <CopyableId
              value={trace.trace_id}
              displayValue={`${trace.trace_id.slice(0, 12)}...${trace.trace_id.slice(-4)}`}
              ariaLabel="Copy trace ID"
            />
          </div>
          <div><span className="detail-card__label">Agent</span><br /><strong>{trace.agent_name}</strong></div>
          <div><span className="detail-card__label">Framework</span><br />{trace.framework ? <Badge label={trace.framework} /> : '—'}</div>
          <div><span className="detail-card__label">Latency</span><br />{trace.latency_ms != null ? <LatencyDisplay ms={trace.latency_ms} /> : '—'}</div>
          <div><span className="detail-card__label">Cost</span><br />{trace.cost_usd != null ? <CostDisplay value={trace.cost_usd} /> : '—'}</div>
          <div><span className="detail-card__label">Time</span><br />{new Date(trace.timestamp).toLocaleString()}</div>
        </div>
      </section>

      {trace.session_id && <SessionStrip trace={trace} />}

      {(trace.input || trace.output) && (
        <section aria-labelledby="trace-io-title" className="detail-section">
          <h2 id="trace-io-title" className="detail-section__title">Input / Output</h2>
          {trace.input && <JsonViewer data={trace.input} label="Input" />}
          {trace.output && <JsonViewer data={trace.output} label="Output" />}
        </section>
      )}

      <section aria-labelledby="trace-spans-title" className="detail-section">
        <h2 id="trace-spans-title" className="detail-section__title">Spans ({spans.length})</h2>
        <SpanTree spans={spans} />
      </section>

      {trace.tool_calls && trace.tool_calls.length > 0 && (
        <section aria-labelledby="trace-tools-title" className="detail-section">
          <h2 id="trace-tools-title" className="detail-section__title">Tool Calls ({trace.tool_calls.length})</h2>
          {trace.tool_calls.map((call, i) => (
            <ToolCallCard key={i} call={call} anchorId={`call-${i}`} />
          ))}
        </section>
      )}

      {evals.length > 0 && (
        <section aria-labelledby="trace-evals-title" className="detail-section">
          <h2 id="trace-evals-title" className="detail-section__title">Evaluations ({evals.length})</h2>
          {evals.map((evalResult) => (
            <EvalDetailCard
              key={evalResult.id}
              evalResult={evalResult}
              rules={rulesByName}
              proofs={proofsByName}
              callHref={(i) => `#call-${i}`}
              input={trace.input}
              questionText={questionText}
              labels={new Map(Object.entries(labels[evalResult.id] ?? {}))}
              onLabel={onLabel}
              labelBusy={labelBusy}
              labelNote={labelNotes[evalResult.id] ?? null}
              onReevaluate={onReevaluate}
              reevaluating={reevaluating === evalResult.id}
              reevaluateNote={reevaluateNotes[evalResult.id] ?? null}
            />
          ))}
        </section>
      )}

      {trace.metadata && (
        <section aria-labelledby="trace-metadata-title" className="detail-section">
          <h2 id="trace-metadata-title" className="detail-section__title">Metadata</h2>
          <JsonViewer data={trace.metadata} label="Metadata" />
        </section>
      )}
    </div>
  );
}
