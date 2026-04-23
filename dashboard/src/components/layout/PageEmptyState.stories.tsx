import type { Meta, StoryObj } from '@storybook/react-vite';
import { Sparkles, Database, AlertTriangle } from 'lucide-react';
import { PageEmptyState } from './PageEmptyState';

const meta: Meta<typeof PageEmptyState> = {
  title: 'Layout/PageEmptyState',
  component: PageEmptyState,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Shared empty-state primitive for list pages. Centered hero with optional icon, title, body, primary CTA, and optional shell command. Used to make empty pages feel intentional instead of broken.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof PageEmptyState>;

export const NoRulesDeployed: Story = {
  args: {
    icon: Sparkles,
    title: 'No custom rules deployed yet',
    body: 'Workflow inversion: rules are born from observed Decision Moments, not authored from scratch.',
  },
};

export const WithCommand: Story = {
  args: {
    icon: Database,
    title: 'No traces yet',
    body: 'Connect an MCP client and make a call to see your first trace appear here.',
    command: 'npx @iris-eval/mcp-server --http --port 6920',
  },
};

export const ErrorState: Story = {
  args: {
    icon: AlertTriangle,
    title: 'Could not load',
    body: 'The API returned an error fetching the list. Check your auth token and network.',
  },
};

export const Minimal: Story = {
  args: {
    title: 'Nothing here yet',
  },
};
