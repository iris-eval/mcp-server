/*
 * The wildcard route (D-1): an unknown address says so, shows the address,
 * and links every section; no axe violations.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { axe } from 'jest-axe';
import { NotFoundPage } from '../../../src/components/layout/NotFoundPage';

describe('NotFoundPage', () => {
  it('names the address and links the sections', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/no/such/page']}>
        <Routes>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Nothing at this address' })).toBeInTheDocument();
    expect(screen.getByText('/no/such/page')).toBeInTheDocument();
    for (const label of ['Dashboard', 'Decision Moments', 'Custom Rules', 'Audit Log']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(await axe(container)).toHaveProperty('violations', []);
  });
});
