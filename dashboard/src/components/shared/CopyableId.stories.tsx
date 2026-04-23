import type { Meta, StoryObj } from '@storybook/react-vite';
import { CopyableId } from './CopyableId';

const meta: Meta<typeof CopyableId> = {
  title: 'Shared/CopyableId',
  component: CopyableId,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Mono-styled ID with a one-click copy affordance. Uses the Clipboard API with an ephemeral "✓ copied" state (1.5s). `displayValue` truncates the visible text while keeping the full ID as the copy target.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof CopyableId>;

export const FullId: Story = {
  args: { value: '26ff4a278f7ca4f283e1d5df57d35158' },
};

export const Truncated: Story = {
  args: {
    value: '26ff4a278f7ca4f283e1d5df57d35158',
    displayValue: '26ff4a278f7c...5158',
  },
};

export const ShortId: Story = {
  args: { value: 'local-tenant' },
};
