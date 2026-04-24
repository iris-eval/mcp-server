/*
 * Dashboard ESLint config — React + TypeScript.
 *
 * Mirrors the root eslint.config.js philosophy (warn-not-error on most
 * style rules, error on real bugs). Adds react-hooks rules to catch
 * common React-specific mistakes (missing deps, conditional hooks).
 *
 * Quality gates the dashboard already has:
 *   - tsc --noEmit (every type error)
 *   - vitest run (96 unit + a11y tests)
 *   - vite build (bundling)
 * This adds the fourth leg: lint catches subtle bugs typecheck misses
 * (unused vars, conditional hook calls, missing useEffect deps).
 */
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    ignores: [
      'dist/',
      'node_modules/',
      'storybook-static/',
      'coverage/',
      '../dist/',
      '*.config.{js,ts}',
      '.storybook/',
    ],
  },
];
