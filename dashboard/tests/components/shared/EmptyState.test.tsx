import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from '../../../src/components/shared/EmptyState';

describe('EmptyState', () => {
  it('renders a custom message when one is provided', () => {
    render(<EmptyState message="No traces yet" />);
    expect(screen.getByText('No traces yet')).toBeInTheDocument();
  });
});
