import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageHeader } from './PageHeader';

const meta: Meta<typeof PageHeader> = {
  title: 'Layout/PageHeader',
  component: PageHeader,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Per-page context strip beneath the app chrome. Renders an optional `h2` (chrome already owns the document `h1`), subtitle, right-aligned meta + actions. Used on every list page.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof PageHeader>;

export const SubtitleOnly: Story = {
  args: {
    subtitle: 'Every trace, classified by significance.',
  },
};

export const WithCountMeta: Story = {
  args: {
    subtitle: 'Custom rules deployed from Decision Moments.',
    meta: (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-caption)', color: 'var(--text-muted)' }}>
        3 deployed
      </span>
    ),
  },
};

export const WithTitleAndActions: Story = {
  args: {
    title: 'Rule activity',
    subtitle: 'Last 24 hours of rule deploys, deletes, and toggles.',
    actions: (
      <button
        type="button"
        style={{
          background: 'var(--iris-500)',
          color: 'var(--bg-base)',
          border: 'none',
          borderRadius: 'var(--radius)',
          padding: 'var(--space-2) var(--space-4)',
          fontSize: 'var(--text-body-sm)',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Deploy new rule
      </button>
    ),
  },
};

export const LongSubtitleWrap: Story = {
  args: {
    subtitle:
      'Output quality across all agents — a continuously updated view that correlates eval pass rates with rule deployments so regressions surface immediately and every moment has a durable narrative attached.',
  },
};
