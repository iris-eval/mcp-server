/*
 * The key ring (arc 8, R-6): every configured key, one constant-time
 * compare, rotation without a gap, and a startup sentence for a bad file,
 * hash or id.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildKeyRing, hasAnyApiKey, sha256Hex, PRIMARY_KEY_ID } from '../../../src/security/keys.js';

const base = { apiKey: undefined as string | undefined, allowUnauthenticated: false, allowedOrigins: [] as string[], rateLimit: { api: 600, mcp: 20 }, requestSizeLimit: '1mb' };

describe('buildKeyRing', () => {
  it('no key anywhere is an empty ring, and hasAnyApiKey agrees; an empty string is no key', () => {
    const ring = buildKeyRing({ ...base });
    expect(ring.empty).toBe(true);
    expect(ring.ids).toEqual([]);
    expect(ring.match('anything')).toBeNull();
    expect(hasAnyApiKey({ ...base })).toBe(false);
    expect(hasAnyApiKey({ ...base, apiKey: '' })).toBe(false);
    expect(hasAnyApiKey({ ...base, apiKeys: [] })).toBe(false);
    expect(hasAnyApiKey({ ...base, apiKey: 'k' })).toBe(true);
    expect(hasAnyApiKey({ ...base, apiKeyFile: '/run/secrets/iris' })).toBe(true);
    expect(hasAnyApiKey({ ...base, apiKeys: [{ id: 'a', keyHash: sha256Hex('x') }] })).toBe(true);
  });

  it('the plaintext primary key matches under the id "primary", and nothing else does', () => {
    const ring = buildKeyRing({ ...base, apiKey: 'secret123' });
    expect(ring.empty).toBe(false);
    expect(ring.ids).toEqual([PRIMARY_KEY_ID]);
    expect(ring.match('secret123')).toBe('primary');
    expect(ring.match('secret124')).toBeNull();
    expect(ring.match('secret12')).toBeNull();
    expect(ring.match('secret1234')).toBeNull();
    expect(ring.match('')).toBeNull();
  });

  it('the primary key can come from a file, trimmed; both sources at once are refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-keys-'));
    try {
      const file = join(dir, 'key');
      writeFileSync(file, '  from-a-file\n');
      const ring = buildKeyRing({ ...base, apiKeyFile: file });
      expect(ring.ids).toEqual(['primary']);
      expect(ring.match('from-a-file')).toBe('primary');
      expect(ring.match('  from-a-file\n')).toBeNull();
      expect(() => buildKeyRing({ ...base, apiKey: 'k', apiKeyFile: file })).toThrow(/both set — one primary key, from one place/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing or empty key file is a sentence naming the path, not a 403 later', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-keys-'));
    try {
      const missing = join(dir, 'nope');
      expect(() => buildKeyRing({ ...base, apiKeyFile: missing })).toThrow(/Cannot read the API key file \(IRIS_API_KEY_FILE \/ security\.apiKeyFile\) ".*nope" \(ENOENT\)/);
      const empty = join(dir, 'empty');
      writeFileSync(empty, '\n  \n');
      expect(() => buildKeyRing({ ...base, apiKeyFile: empty })).toThrow(/is empty\. The file's trimmed contents are the key/);
      expect(() => buildKeyRing({ ...base, apiKeys: [{ id: 'ci', keyFile: missing }] })).toThrow(/the key file for security\.apiKeys "ci"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('further keys by hash: the config holds no secret, each matches under its own id, primary first', () => {
    const ring = buildKeyRing({
      ...base,
      apiKey: 'old-key',
      apiKeys: [
        { id: 'ci-2026-10', keyHash: sha256Hex('new-key') },
        { id: 'partner', keyHash: sha256Hex('partner-key').toUpperCase() },
      ],
    });
    expect(ring.ids).toEqual(['primary', 'ci-2026-10', 'partner']);
    expect(ring.match('old-key')).toBe('primary');
    expect(ring.match('new-key')).toBe('ci-2026-10');
    expect(ring.match('partner-key')).toBe('partner');
    expect(ring.match(sha256Hex('new-key'))).toBeNull(); // the hash is not the key
  });

  it('rotation without a gap: both keys authenticate until the old one is removed', () => {
    const before = buildKeyRing({ ...base, apiKey: 'old-key' });
    expect(before.match('new-key')).toBeNull();
    const during = buildKeyRing({ ...base, apiKey: 'old-key', apiKeys: [{ id: 'next', keyHash: sha256Hex('new-key') }] });
    expect(during.match('old-key')).toBe('primary');
    expect(during.match('new-key')).toBe('next');
    const after = buildKeyRing({ ...base, apiKeys: [{ id: 'next', keyHash: sha256Hex('new-key') }] });
    expect(after.match('old-key')).toBeNull();
    expect(after.match('new-key')).toBe('next');
  });

  it('a key past expiresAt stops matching at that instant, and is listed as expired when already past at build', () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const ring = buildKeyRing({ ...base, apiKeys: [{ id: 'temp', keyHash: sha256Hex('t'), expiresAt: soon }] });
    expect(ring.expired).toEqual([]);
    expect(ring.match('t')).toBe('temp');
    expect(ring.match('t', Date.parse(soon) + 1)).toBeNull();
    expect(ring.match('t', Date.parse(soon))).toBeNull();
    const past = buildKeyRing({ ...base, apiKeys: [{ id: 'gone', keyHash: sha256Hex('g'), expiresAt: '2020-01-01T00:00:00Z' }] });
    expect(past.expired).toEqual(['gone']);
    expect(past.empty).toBe(false);
    expect(past.match('g')).toBeNull();
    expect(() => buildKeyRing({ ...base, apiKeys: [{ id: 'bad', keyHash: sha256Hex('b'), expiresAt: 'next tuesday' }] })).toThrow(/expiresAt "next tuesday", which is not a date/);
  });

  it('a malformed entry is refused by index and id: bad hash, both or neither source, empty id, duplicate id', () => {
    expect(() => buildKeyRing({ ...base, apiKeys: [{ id: 'x', keyHash: 'abc' }] })).toThrow(/security\.apiKeys\[0\] \("x"\): keyHash must be the sha256 of the key as 64 hex characters/);
    expect(() => buildKeyRing({ ...base, apiKeys: [{ id: 'x', keyHash: sha256Hex('a'), keyFile: '/k' }] })).toThrow(/set exactly one of keyFile .* or keyHash/);
    expect(() => buildKeyRing({ ...base, apiKeys: [{ id: 'x' }] })).toThrow(/set exactly one of keyFile .* or keyHash/);
    expect(() => buildKeyRing({ ...base, apiKeys: [{ id: '  ', keyHash: sha256Hex('a') }] })).toThrow(/every key needs a non-empty id/);
    expect(() => buildKeyRing({ ...base, apiKeys: [{ id: 'dup', keyHash: sha256Hex('a') }, { id: 'dup', keyHash: sha256Hex('b') }] })).toThrow(/two keys carry the id "dup"/);
    expect(() => buildKeyRing({ ...base, apiKey: 'k', apiKeys: [{ id: 'primary', keyHash: sha256Hex('b') }] })).toThrow(/two keys carry the id "primary"/);
  });

  it('the compare walks the whole ring every time — the match is the first live key, and a later duplicate hash is not reported twice', () => {
    const ring = buildKeyRing({ ...base, apiKeys: [{ id: 'a', keyHash: sha256Hex('same') }, { id: 'b', keyHash: sha256Hex('same') }] });
    expect(ring.match('same')).toBe('a');
  });

  it('sha256Hex is the documented recipe (openssl dgst -sha256)', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
