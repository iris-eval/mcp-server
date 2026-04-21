import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LatencyDisplay } from '../../../src/components/shared/LatencyDisplay';

describe('LatencyDisplay', () => {
  it('renders sub-second latencies in ms', () => {
    render(<LatencyDisplay ms={250} />);
    expect(screen.getByText('250ms')).toBeInTheDocument();
  });
});
