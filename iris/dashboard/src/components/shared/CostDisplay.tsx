import { formatCost } from '../../utils/formatters';

export function CostDisplay({ value }: { value: number }) {
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-sm)' }}>
      {formatCost(value)}
    </span>
  );
}
