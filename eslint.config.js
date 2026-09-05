import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'warn',
    },
  },
  /*
   * Type-aware rules, on the async surface only (0.10.0). The engine returns
   * promises now, so a forgotten await is a real defect: no-floating-promises
   * catches a result thrown away, no-misused-promises catches a promise passed
   * where a value is expected, and await-thenable catches the opposite mistake —
   * an await on something that was never a promise, which is how a mechanical
   * refactor hides a construction inside what reads like an evaluation.
   */
  {
    files: ['src/eval/**/*.ts', 'src/tools/**/*.ts', 'src/dashboard/routes/**/*.ts', 'src/self-test.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'dashboard/', 'coverage/'],
  },
];
