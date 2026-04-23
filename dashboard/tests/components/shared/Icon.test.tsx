import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Activity, LayoutDashboard, Sparkles } from 'lucide-react';
import { Icon } from '../../../src/components/shared/Icon';

describe('Icon primitive', () => {
  it('renders the lucide component passed via `as`', () => {
    const { container } = render(<Icon as={Activity} label="Decision Moments" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    // Lucide icons render as SVG with a viewBox set to 0 0 24 24
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    // And contain at least one drawing primitive (path / polyline / circle)
    expect(
      container.querySelectorAll('svg path, svg polyline, svg circle').length,
    ).toBeGreaterThan(0);
  });

  it('defaults to size 16 when no size prop given', () => {
    const { container } = render(<Icon as={LayoutDashboard} label="Dashboard" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('height')).toBe('16');
  });

  it('respects 14 / 20 / 24 size choices', () => {
    const sizes = [14, 20, 24] as const;
    for (const size of sizes) {
      const { container, unmount } = render(<Icon as={Sparkles} size={size} label="x" />);
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('width')).toBe(String(size));
      unmount();
    }
  });

  it('uses 1.5px stroke (locked per Design System v2)', () => {
    const { container } = render(<Icon as={Activity} label="x" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('stroke-width')).toBe('1.5');
  });

  it('attaches aria-label + role=img when label provided', () => {
    render(<Icon as={Activity} label="Decision Moments" />);
    const icon = screen.getByRole('img', { name: 'Decision Moments' });
    expect(icon).toBeInTheDocument();
  });

  it('marks decorative icons aria-hidden when no label', () => {
    const { container } = render(<Icon as={Activity} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('aria-label')).toBeNull();
  });

  it('inherits currentColor by default', () => {
    const { container } = render(<Icon as={Activity} label="x" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('style') || '').toContain('color: inherit');
  });
});
