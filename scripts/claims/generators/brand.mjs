// Brand generator — emits canonical brand constants.
//
// For PR-1 these are hardcoded here as the single source of truth, with the
// tagline + description verified against package.json.description for
// consistency. Future PRs can extract a website/src/lib/brand-constants.ts
// module that this generator reads from instead.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const TAGLINE = 'Stop shipping agents on vibes';

/*
 * Two sentences every public surface must say the same way, because on
 * 2026-09-07 they were said ten and five different ways and two of them were
 * false. "Discovers it automatically" was true only of the client listing
 * the tools at session start — nothing auto-installs Iris and nothing makes
 * the model call it — and "never leaves your machine" omitted the OTel
 * exporter that ships traces off-box when configured. A fact stated in
 * many places is a fact that drifts; these are stated once.
 *
 * The residency sentence names EVERY way out, and
 * tests/data-residency-names-every-exit.test.ts holds it to the code: the
 * source files that open an outbound connection are enumerated there, each
 * with the words this sentence must carry for it. Until 2026-10-02 it named
 * two of four (the exporter and the judge), while the server also fetched
 * cited pages and posted webhooks, and the security page said "No data ever
 * leaves your environment".
 */
const DISCOVERY_SENTENCE = "Add the config block, restart your client, and every session lists Iris's tools on connect. Iris never intercepts: it runs when your agent calls one of its tools, when a host hook or `iris-eval ingest` hands it a trace, or when you POST one to its HTTP API.";
const DATA_RESIDENCY = "Nothing leaves your machine unless you turn one of these on: an OpenTelemetry endpoint (IRIS_OTEL_ENDPOINT), which exports traces to the collector you name; the LLM judge with your own key, which sends the text it judges to that provider, and whose citation check fetches the pages an output cites; or a webhook, which posts ids, the verdict and rule names, never the text, to the address you set.";

export async function generate() {
  // Cross-check: package.json.description should start with the tagline.
  const pkgRaw = await readFile(resolve(root, 'package.json'), 'utf-8');
  const pkg = JSON.parse(pkgRaw);
  if (!pkg.description?.startsWith(TAGLINE)) {
    throw new Error(
      `Brand generator: package.json description should start with tagline "${TAGLINE}", got "${pkg.description?.slice(0, 60) ?? '(empty)'}"`,
    );
  }

  return {
    tagline: TAGLINE,
    categoryName: 'Agent Eval',
    coinedTerms: [
      'Eval Tax',
      'Eval Drift',
      'Eval Gap',
      'Eval Coverage',
      'Eval-Driven Development',
      'Eval Loop',
    ],
    websiteUrl: 'https://iris-eval.com',
    publicRepoUrl: 'https://github.com/iris-eval/mcp-server',
    npmPackage: '@iris-eval/mcp-server',
    supportEmail: 'hello@iris-eval.com',
    securityEmail: 'security@iris-eval.com',
    discoverySentence: DISCOVERY_SENTENCE,
    dataResidency: DATA_RESIDENCY,
  };
}
