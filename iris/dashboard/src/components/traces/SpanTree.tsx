import type { Span } from '../../api/types';
import { SpanRow } from './SpanRow';

function buildTree(spans: Span[]): Array<{ span: Span; depth: number }> {
  const childMap = new Map<string | undefined, Span[]>();
  for (const span of spans) {
    const key = span.parent_span_id ?? '__root__';
    const children = childMap.get(key) ?? [];
    children.push(span);
    childMap.set(key, children);
  }

  const result: Array<{ span: Span; depth: number }> = [];
  function walk(parentId: string | undefined, depth: number) {
    const key = parentId ?? '__root__';
    const children = childMap.get(key) ?? [];
    for (const child of children) {
      result.push({ span: child, depth });
      walk(child.span_id, depth + 1);
    }
  }
  walk(undefined, 0);

  // If tree building found nothing (no root spans), flatten
  if (result.length === 0) {
    return spans.map((span) => ({ span, depth: 0 }));
  }
  return result;
}

export function SpanTree({ spans }: { spans: Span[] }) {
  if (spans.length === 0) {
    return <div style={{ padding: 'var(--space-4)', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>No spans recorded</div>;
  }

  const tree = buildTree(spans);
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius-lg)', overflow: 'hidden' }}>
      {tree.map(({ span, depth }) => (
        <SpanRow key={span.span_id} span={span} depth={depth} />
      ))}
    </div>
  );
}
