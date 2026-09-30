/*
 * The live key ring (src/security/live-key-ring.ts) against real files in a
 * temp directory: a key removed from config.json, a key file deleted, a
 * config file mid-edit, and the fix. The server-level proof, a revocation
 * while the real CLI is serving, is tests/integration/key-revocation-live.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveKeyRing } from '../../../src/security/live-key-ring.js';
import { sha256Hex } from '../../../src/security/keys.js';

let dir: string;
let configPath: string;
let loads: number;
let events: Array<Record<string, unknown>>;

type Keys = { apiKeys?: Array<{ id: string; keyHash?: string; keyFile?: string; expiresAt?: string }> };
const writeConfig = (security: Keys | string): void =>
  writeFileSync(configPath, typeof security === 'string' ? security : JSON.stringify({ security }));
/** The security block from the file, the way loadSecurityConfig reads it (the test needs only the keys). */
const load = () => {
  loads++;
  return (JSON.parse(readFileSync(configPath, 'utf8')) as { security: Keys }).security;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'iris-live-ring-'));
  configPath = join(dir, 'config.json');
  loads = 0;
  events = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

function ring(fixedApiKey?: string) {
  const initial = load();
  loads = 0;
  return createLiveKeyRing({ ...initial, apiKey: fixedApiKey }, {
    load: () => ({ ...load(), apiKey: fixedApiKey }),
    configPath,
    fixedApiKey,
    onReload: (e) => events.push(e),
  });
}

describe('the live key ring', () => {
  it('a key removed from config.json stops matching on the next question, with no restart', () => {
    writeConfig({ apiKeys: [{ id: 'leaked', keyHash: sha256Hex('leaked-key') }, { id: 'kept', keyHash: sha256Hex('kept-key') }] });
    const r = ring();
    expect(r.match('leaked-key')).toBe('leaked');
    expect(r.expiryOf('leaked')).toBeNull();

    writeConfig({ apiKeys: [{ id: 'kept', keyHash: sha256Hex('kept-key') }] });

    expect(r.match('leaked-key')).toBeNull();
    expect(r.expiryOf('leaked')).toBeUndefined();
    expect(r.match('kept-key')).toBe('kept');
    expect(events).toEqual([{ ok: true, ids: ['kept'], dropped: [] }]);
  });

  it('reads nothing while the files are unchanged: one stat per file per question, one load per change', () => {
    writeConfig({ apiKeys: [{ id: 'a', keyHash: sha256Hex('a-key') }] });
    const r = ring();
    for (let i = 0; i < 50; i++) expect(r.match('a-key')).toBe('a');
    expect(loads).toBe(0);
    writeConfig({ apiKeys: [{ id: 'a', keyHash: sha256Hex('a-key') }, { id: 'b', keyHash: sha256Hex('b-key') }] });
    for (let i = 0; i < 50; i++) expect(r.match('b-key')).toBe('b');
    expect(loads).toBe(1);
  });

  it('deleting a key\'s file revokes that key alone; putting it back restores it', () => {
    const fileA = join(dir, 'a.key');
    const fileB = join(dir, 'b.key');
    writeFileSync(fileA, 'file-key-a\n');
    writeFileSync(fileB, 'file-key-b\n');
    writeConfig({ apiKeys: [{ id: 'a', keyFile: fileA }, { id: 'b', keyFile: fileB }] });
    const r = ring();
    expect(r.match('file-key-a')).toBe('a');

    unlinkSync(fileA);
    expect(r.match('file-key-a')).toBeNull();
    expect(r.match('file-key-b')).toBe('b');
    expect(events.at(-1)).toEqual({ ok: true, ids: ['b'], dropped: ['a'] });

    writeFileSync(fileA, 'file-key-a\n');
    expect(r.match('file-key-a')).toBe('a');
  });

  it('rewriting a key file replaces the key: the old secret stops matching', () => {
    const file = join(dir, 'k.key');
    writeFileSync(file, 'old-secret\n');
    writeConfig({ apiKeys: [{ id: 'k', keyFile: file }] });
    const r = ring();
    expect(r.match('old-secret')).toBe('k');
    writeFileSync(file, 'new-secret-longer\n');
    expect(r.match('old-secret')).toBeNull();
    expect(r.match('new-secret-longer')).toBe('k');
  });

  it('a config file that cannot be read fails closed to the environment key, and fixing it restores the keys', () => {
    writeConfig({ apiKeys: [{ id: 'a', keyHash: sha256Hex('a-key') }] });
    const r = ring('env-key');
    expect(r.match('a-key')).toBe('a');
    expect(r.match('env-key')).toBe('primary');

    writeConfig('{ "security": { "apiKeys": [ ');
    expect(r.match('a-key')).toBeNull();
    expect(r.match('env-key')).toBe('primary');
    expect(events.at(-1)).toMatchObject({ ok: false });

    writeConfig({ apiKeys: [{ id: 'a', keyHash: sha256Hex('a-key') }] });
    expect(r.match('a-key')).toBe('a');
  });

  it('a new expiresAt applies on the next question', () => {
    writeConfig({ apiKeys: [{ id: 'a', keyHash: sha256Hex('a-key') }] });
    const r = ring();
    expect(r.match('a-key')).toBe('a');
    writeConfig({ apiKeys: [{ id: 'a', keyHash: sha256Hex('a-key'), expiresAt: '2020-01-01T00:00:00Z' }] });
    expect(r.match('a-key')).toBeNull();
    expect(r.expiryOf('a')).toBe(Date.parse('2020-01-01T00:00:00Z'));
  });

  it('whether auth is on is fixed at boot: removing every key refuses every key, it never opens the server', () => {
    writeConfig({ apiKeys: [{ id: 'a', keyHash: sha256Hex('a-key') }] });
    const r = ring();
    expect(r.empty).toBe(false);
    writeConfig({ apiKeys: [] });
    expect(r.match('a-key')).toBeNull();
    expect(r.ids).toEqual([]);
    expect(r.empty).toBe(false);
  });
});
