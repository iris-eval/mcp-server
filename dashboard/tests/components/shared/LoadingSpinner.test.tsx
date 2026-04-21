import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoadingSpinner } from '../../../src/components/shared/LoadingSpinner';

describe('LoadingSpinner', () => {
  it('renders the loading indicator text', () => {
    render(<LoadingSpinner />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});
