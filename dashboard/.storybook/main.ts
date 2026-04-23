/*
 * Storybook config — React + Vite builder.
 *
 * Why Storybook at all: the dashboard has ~40 shared primitives + chart
 * components. Without a catalog, every PR that touches visuals has to
 * manually validate 10+ screens to catch regressions. Storybook is the
 * catalog; CI runs build-storybook to smoke-compile every story so a
 * broken primitive fails the build before it ships.
 *
 * Scope for v0.4.0 (audit item #11 baseline):
 *   - Story file per shared primitive (PageHeader, PageEmptyState,
 *     PassRateGauge, Donut, Badge, LoadingSpinner, etc.)
 *   - CI `build-storybook` smoke to catch broken stories
 *   - Pixel regression (Chromatic / lost-pixel) deferred — vendor choice
 *     is a separate founder decision with recurring-cost implications
 */
import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: [
    '../src/**/*.stories.@(ts|tsx|mdx)',
  ],
  addons: ['@storybook/addon-docs'],
  docs: { autodocs: 'tag' },
  typescript: {
    // Story props pull types from the component itself via `Meta<typeof X>`.
    reactDocgen: 'react-docgen-typescript',
  },
};

export default config;
