import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvalSparkline } from '../../../src/components/shared/EvalSparkline';

describe('EvalSparkline', () => {
  it('renders an empty-state placeholder when data is empty', () => {
    render(<EvalSparkline data={[]} />);
    expect(screen.getByText('no data')).toBeInTheDocument();
  });

  it('renders the chart wrapper (not the empty state) when data is non-empty', () => {
    const data = [
      { timestamp: '2026-04-15T00:00:00Z', score: 0.8 },
      { timestamp: '2026-04-16T00:00:00Z', score: 0.75 },
      { timestamp: '2026-04-17T00:00:00Z', score: 0.7 },
    ];
    render(<EvalSparkline data={data} ariaLabel="trend" />);
    // Recharts ResponsiveContainer needs real layout to render SVG, which jsdom lacks.
    // The meaningful assertion is that we didn't fall into the empty-state branch
    // and that the labelled wrapper exists.
    expect(screen.queryByText('no data')).not.toBeInTheDocument();
    expect(screen.getByLabelText('trend')).toBeInTheDocument();
  });

  it('uses a custom aria label when provided', () => {
    const data = [{ timestamp: '2026-04-15T00:00:00Z', score: 0.5 }];
    render(<EvalSparkline data={data} ariaLabel="Helpfulness rule trend" />);
    expect(screen.getByLabelText('Helpfulness rule trend')).toBeInTheDocument();
  });
});
