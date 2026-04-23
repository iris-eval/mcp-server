import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from './Badge';

const meta: Meta<typeof Badge> = {
  title: 'Shared/Badge',
  component: Badge,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Small, color-coded status pill. Used for span kinds, eval verdicts, and framework chips. Variant resolves to color pairs (bg + fg); unknown labels fall back to neutral UNSET styling.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof Badge>;

export const Pass: Story = { args: { label: 'pass' } };
export const Fail: Story = { args: { label: 'fail' } };
export const OK: Story = { args: { label: 'OK' } };
export const Error: Story = { args: { label: 'ERROR' } };
export const LLMSpan: Story = { args: { label: 'LLM' }, name: 'LLM span' };
export const ToolSpan: Story = { args: { label: 'TOOL' }, name: 'Tool span' };
export const UnknownFallback: Story = {
  args: { label: 'unknown-variant' },
  name: 'Unknown label (fallback)',
};
