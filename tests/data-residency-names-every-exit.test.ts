/*
 * The sentence that says what leaves the machine names every way out.
 *
 * `brand.dataResidency` is printed on the README, the home, pricing,
 * compare, privacy and security pages, llms.txt and the MCP manifest. It
 * named two exits (the OpenTelemetry exporter and the LLM judge) while the
 * server had four: it also fetched the pages an output cites and posted
 * webhooks. The security page went further and said "No data ever leaves
 * your environment".
 *
 * A sentence about the code is held to the code: every source file that
 * opens an outbound connection is listed here with the words the sentence
 * must carry for it. A fifth way out fails the first test until it is
 * listed, and the second until the sentence says it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const claims = JSON.parse(read('.claims.json')) as { brand: { dataResidency: string } };

/** Each way out of the deployment, and the words the sentence says it with. */
const EXITS: Record<string, RegExp> = {
  'src/otel/exporter.ts': /an OpenTelemetry endpoint \(IRIS_OTEL_ENDPOINT\), which exports traces to the collector you name/,
  'src/eval/llm-judge/client.ts': /the LLM judge with your own key, which sends the text it judges to that provider/,
  'src/eval/citation-verify/resolve.ts': /whose citation check fetches the pages an output cites/,
  'src/notify/webhook.ts': /a webhook, which posts ids, the verdict and rule names, never the text, to the address you set/,
};

/** Opens a connection, and is not a way out: the client a script uses to reach the Iris server it names. */
const NOT_AN_EXIT = new Set(['src/client.ts']);

const OPENS_A_CONNECTION = /\bfetch(?:Impl)?\(|\bhttps?\.(?:request|get)\(|\b(?:net|tls)\.connect\(|\bnew WebSocket\(|\bcreateConnection\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith('.ts')) out.push(relative(root, p).replace(/\\/g, '/'));
  }
  return out;
}

/** The code of a file without its comments, so a sentence about fetching is not read as a fetch. */
const code = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

describe('what leaves the machine', () => {
  it('every source file that opens an outbound connection is a way out the sentence lists', () => {
    const callers = sourceFiles(join(root, 'src')).filter((f) => OPENS_A_CONNECTION.test(code(read(f))));
    expect(callers.filter((f) => !NOT_AN_EXIT.has(f)).sort()).toEqual(Object.keys(EXITS).sort());
    for (const f of NOT_AN_EXIT) expect(callers, `${f} no longer opens a connection; drop it from NOT_AN_EXIT`).toContain(f);
  });

  it('the sentence says each one', () => {
    for (const [file, words] of Object.entries(EXITS)) expect(claims.brand.dataResidency, file).toMatch(words);
    expect(claims.brand.dataResidency.startsWith('Nothing leaves your machine unless you turn one of these on:')).toBe(true);
  });

  it('the security page prints the sentence, and no page says nothing ever leaves', () => {
    const security = read('website/src/app/security/page.tsx');
    expect(security).toContain('{DATA_RESIDENCY}');
    const absolute = /no data (?:ever )?leaves|never leaves your (?:machine|environment)|nothing ever leaves/i;
    const pages = sourceFiles(join(root, 'website', 'src')).concat(
      readdirSync(join(root, 'website', 'src', 'app'), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith('.tsx'))
        .map((f) => `website/src/app/${f.replace(/\\/g, '/')}`),
    );
    for (const page of new Set(pages)) expect(read(page), page).not.toMatch(absolute);
    expect(read('README.md')).not.toMatch(absolute);
  });
});
