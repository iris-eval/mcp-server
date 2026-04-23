/*
 * Storybook global preview — mounts v2.A tokens + dark theme by default.
 *
 * The dashboard's design language lives in src/styles/tokens.css. Stories
 * import it so every rendered primitive gets the exact same visual
 * treatment as the live product.
 */
import type { Preview } from '@storybook/react-vite';
import '../src/styles/tokens.css';

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: '#050508' },   // --bg-base
        { name: 'raised', value: '#08080e' }, // --bg-raised
        { name: 'surface', value: '#0d0d15' },
      ],
    },
    layout: 'padded',
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
  },
  globalTypes: {
    theme: {
      name: 'Theme',
      description: 'Brand theme',
      defaultValue: 'dark',
      toolbar: {
        icon: 'circlehollow',
        items: ['dark', 'light'],
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme ?? 'dark';
      document.documentElement.setAttribute('data-theme', theme);
      return Story();
    },
  ],
};

export default preview;
