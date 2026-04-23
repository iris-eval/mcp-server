import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/*
 * jest-axe ships a matcher shaped for jest; Vitest's expect.extend
 * signature differs. To stay matcher-agnostic, a11y tests in tests/a11y/
 * call `axe(container)` directly and assert
 * `expect(result.violations).toEqual([])`. If violations exist the
 * vitest diff prints the full rule list, which is what we want.
 */

afterEach(() => {
  cleanup();
});
