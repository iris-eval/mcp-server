import type { Meta, StoryObj } from '@storybook/react-vite';
import { PassRateGauge } from './PassRateGauge';

const meta: Meta<typeof PassRateGauge> = {
  title: 'Charts/PassRateGauge',
  component: PassRateGauge,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Semicircle pass-rate meter — the Health view\'s hero metric. Animates from 0 to the target value, colored against the 90% threshold line.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof PassRateGauge>;

export const Healthy: Story = {
  args: { value: 0.94, delta: 0.02, totalEvals: 142, agentCount: 7, periodLabel: '30d' },
  name: 'Healthy (94%)',
};

export const AtThreshold: Story = {
  args: { value: 0.9, delta: 0, totalEvals: 80, agentCount: 4, periodLabel: '30d' },
  name: 'At threshold (90%)',
};

export const BelowThreshold: Story = {
  args: { value: 0.78, delta: -0.04, totalEvals: 60, agentCount: 3, periodLabel: '30d' },
  name: 'Below threshold (78%)',
};

export const NoData: Story = {
  args: { totalEvals: 0, periodLabel: '30d' },
  name: 'No data (empty state)',
};
