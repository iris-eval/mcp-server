/*
 * Is the server under test the build under test? (#665)
 *
 * The dashboard's index.html names its entry script and stylesheet by
 * content hash, so the page a server returns for `/` identifies the
 * dashboard build it serves. globalSetup compares that page with
 * dist/dashboard/index.html, the build this checkout just made, and stops
 * the run when they differ: before this, a server left on the port quietly
 * answered every test with its own bundle.
 */

/** The hashed asset references in an index.html, in order: what identifies the build. */
export function buildAssets(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
}

/**
 * Throws, naming the port and both builds, when the served page is not the
 * built one. Returns the assets it matched on otherwise.
 */
export function assertServesThisBuild(servedHtml: string, builtHtml: string, baseUrl: string): string[] {
  const built = buildAssets(builtHtml);
  if (built.length === 0) {
    throw new Error('dist/dashboard/index.html names no /assets/ files: build the dashboard first (npm run build).');
  }
  const served = buildAssets(servedHtml);
  if (served.join('\n') !== built.join('\n')) {
    throw new Error(
      `The server at ${baseUrl} is not the build under test. It serves ${served.length > 0 ? served.join(', ') : 'no dashboard assets'}; ` +
        `this checkout built ${built.join(', ')}. Another Iris is probably listening on that port: stop it, or run with ` +
        'E2E_PORT unset so the suite picks a free port, and rebuild if the build is stale.',
    );
  }
  return built;
}
