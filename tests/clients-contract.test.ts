/*
 * The client rows are drift-locked to the installer and to the prose (arc 8, R-4).
 *
 * clients.json names every MCP client Iris says it runs in, one row each,
 * with a status word — verified (a test in this repository drives the
 * client's real integration surface on every CI run) or claimed (the
 * installer writes the configuration shape the client documents, and that
 * writer is tested on the shape; nobody on the Iris side watched the client
 * connect) — the evidence, the source it was read from and the date. This
 * file locks it: the rows are exactly the installer's client profiles; each
 * row's config mode is the profile's and its config text names the file the
 * installer writes; every evidence path exists and a verified row's evidence
 * includes a test; every source is an https URL and every date is a real
 * date not in the future; the truthbase carries the rows verbatim with the
 * counts; and the README, the install section, llms.txt and the sitemap
 * render their client lists from the rows rather than from a typed list —
 * so no client is called supported without a row.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import clientsFile from '../clients.json' with { type: 'json' };
import { allProfiles, configPathFor, type SupportedClient } from '../packages/init/src/detect.js';
import { generate as generateClients, STATUSES } from '../scripts/claims/generators/clients.mjs';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');

type Row = (typeof clientsFile.rows)[number];
const rows: Row[] = clientsFile.rows;
const verified = rows.filter((r) => r.status === 'verified');
const claimed = rows.filter((r) => r.status === 'claimed');

describe('clients.json — the rows are the installer’s profiles', () => {
  it('names exactly the clients the installer knows, in its order, with its display names and config modes', () => {
    const profiles = allProfiles();
    expect(rows.map((r) => r.id)).toEqual(profiles.map((p) => p.id));
    for (const p of profiles) {
      const row = rows.find((r) => r.id === p.id);
      expect(row?.name, p.id).toBe(p.displayName);
      expect(row?.configMode, p.id).toBe(p.configMode);
    }
  });

  it('each row’s config text names the file the installer writes for that client', () => {
    for (const row of rows) {
      const file = basename(configPathFor(row.id as SupportedClient));
      expect(row.config, `${row.id} should name ${file}`).toContain(file);
    }
  });

  it('every row carries a status the file allows, evidence that exists, an https source and a real date not in the future', () => {
    expect(clientsFile.statuses).toEqual(STATUSES);
    const today = new Date().toISOString().slice(0, 10);
    for (const row of rows) {
      expect(STATUSES, row.id).toContain(row.status);
      expect(row.evidence.length, row.id).toBeGreaterThan(0);
      for (const path of row.evidence) expect(existsSync(join(root, path)), `${row.id}: ${path}`).toBe(true);
      expect(row.source, row.id).toMatch(/^https:\/\/[^\s]+$/);
      expect(row.lastChecked, row.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.lastChecked <= today, `${row.id}: ${row.lastChecked} is after today`).toBe(true);
      expect(row.summary.length, row.id).toBeGreaterThan(40);
    }
  });

  it('a verified row’s evidence includes a test; a claimed row says no test launches the client', () => {
    expect(verified.length).toBeGreaterThan(0);
    for (const row of verified) expect(row.evidence.some((p) => p.startsWith('tests/')), row.id).toBe(true);
    for (const row of claimed) expect(row.summary, row.id).toMatch(/No test launches/);
  });
});

describe('the truthbase carries the rows', () => {
  it('.claims.json clients equals the generator’s output: the rows verbatim, the counts by status, the total', async () => {
    const claims = JSON.parse(read('.claims.json')) as { clients: Awaited<ReturnType<typeof generateClients>> };
    const generated = await generateClients();
    expect(claims.clients).toEqual(generated);
    expect(claims.clients.rows).toEqual(rows);
    expect(claims.clients.counts).toEqual({ verified: verified.length, claimed: claimed.length });
    expect(claims.clients.total).toBe(rows.length);
  });
});

describe('the prose surfaces render their client lists from the rows', () => {
  const verifiedNames = verified.map((r) => r.name);
  const claimedNames = claimed.map((r) => r.name);

  it('the README names the verified clients and the claimed clients as the rows have them, and points at the page', () => {
    const readme = read('README.md');
    expect(readme).toContain(`Verified on every CI run: ${verifiedNames.join(', ')}`);
    expect(readme).toContain(`nobody on the Iris side has watched it connect: ${claimedNames.join(', ')}.`);
    expect(readme).toContain('https://iris-eval.com/clients');
  });

  it('the install section renders the names from the reader, not from a typed list', () => {
    const install = read('website/src/components/install.tsx');
    expect(install).toMatch(/CLIENT_NAMES_VERIFIED/);
    expect(install).toMatch(/CLIENT_NAMES_CLAIMED/);
    expect(install).not.toMatch(/Works with Claude Desktop, Cursor/);
    expect(install).toContain('href="/clients"');
  });

  it('the clients page renders from the reader and the sitemap lists it', () => {
    const page = read('website/src/app/clients/page.tsx');
    expect(page).toMatch(/import \{[^}]*\bCLIENTS\b[^}]*\} from "@\/lib\/claims"/);
    expect(page).not.toMatch(/Claude Desktop|Cursor|Windsurf/);
    expect(read('website/src/app/sitemap.ts')).toContain('page("/clients"');
    expect(read('website/src/lib/claims.ts')).toMatch(/export const CLIENTS = /);
  });

  it('llms.txt takes the sentence from the rows through a slot, and the rendered text names them all', () => {
    const template = read('website/llms.template.txt');
    expect(template).toContain('{{clientsSentence}}');
    expect(template).not.toMatch(/Claude Desktop, Claude Code, Cursor/);
    const rendered = read('website/public/llms.txt');
    for (const name of [...verifiedNames, ...claimedNames]) expect(rendered, name).toContain(name);
    expect(rendered).toContain('https://iris-eval.com/clients');
  });
});
