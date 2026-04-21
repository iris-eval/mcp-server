import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pagination } from '../../../src/components/shared/Pagination';

describe('Pagination', () => {
  it('disables Previous on the first page', () => {
    const onPageChange = vi.fn();
    render(<Pagination total={100} limit={20} offset={0} onPageChange={onPageChange} />);
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next/i })).toBeEnabled();
  });

  it('advances offset when Next is clicked', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<Pagination total={100} limit={20} offset={20} onPageChange={onPageChange} />);
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(onPageChange).toHaveBeenCalledWith(40);
  });
});
