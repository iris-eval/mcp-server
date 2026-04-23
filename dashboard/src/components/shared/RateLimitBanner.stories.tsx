import type { Meta, StoryObj } from '@storybook/react-vite';
import { RateLimitBanner } from './RateLimitBanner';

const meta: Meta<typeof RateLimitBanner> = {
  title: 'Shared/RateLimitBanner',
  component: RateLimitBanner,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Surfaces the client-side effect of a 429. Shown above the primary content of a rate-limited view while polling is paused. The countdown auto-ticks. A manual retry button hands back to the page\'s `refetch` so a user who knows the server is healthy can try immediately.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof RateLimitBanner>;

export const ShortCooldown: Story = {
  args: { until: Date.now() + 30_000 },
  name: 'Short (30s) cooldown',
};

export const LongCooldown: Story = {
  args: { until: Date.now() + 120_000 },
  name: 'Long (2m) cooldown',
};

export const WithRetry: Story = {
  args: {
    until: Date.now() + 60_000,
    onRetry: () => alert('refetch() called from parent page hook'),
  },
  name: 'With manual retry',
};
