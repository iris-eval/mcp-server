/*
 * The key ring — every API key the server accepts, and rotation without a
 * gap (arc 8, R-6).
 *
 * Until 0.15.0 there was one key, `security.apiKey` (IRIS_API_KEY /
 * --api-key), held in plaintext in the environment or the config file, and
 * rotating it meant a moment where either the old clients or the new ones
 * were locked out. Three things change here:
 *
 *   IRIS_API_KEY_FILE / security.apiKeyFile   the primary key read from a
 *                        file — the secret-file pattern Docker and
 *                        Kubernetes mount, so the key never sits in an
 *                        environment block or a process listing.
 *   security.apiKeys     any number of further keys, each with an `id`,
 *                        either a `keyFile` or a `keyHash` (the sha256 hex
 *                        of the key, so the config file itself holds no
 *                        secret), and an optional `expiresAt`.
 *   rotation             add the new key, restart, move the clients, remove
 *                        the old key, restart. Every key authenticates until
 *                        it is removed or expires; a key past `expiresAt`
 *                        stops matching at that instant, no restart needed.
 *
 * Matching is one shape for every key: the candidate is hashed and compared
 * to every stored hash with `timingSafeEqual` on 32-byte buffers, the whole
 * ring every time — the compare does not depend on the candidate's length,
 * on which key matched, or on whether any did. The ring is built once at
 * boot (`buildKeyRing`), which is also when a missing or empty key file, a
 * malformed hash or a duplicate id refuses startup with a sentence.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IrisConfig } from '../types/config.js';

export type SecurityConfig = IrisConfig['security'];

/** The id the single `security.apiKey` / `apiKeyFile` key carries. */
export const PRIMARY_KEY_ID = 'primary';

export interface KeyRing {
  /** No key is configured anywhere: the Bearer middleware is a pass-through. */
  readonly empty: boolean;
  /** Every configured key's id, primary first, in config order. */
  readonly ids: readonly string[];
  /** Ids whose `expiresAt` had already passed when the ring was built. */
  readonly expired: readonly string[];
  /** The id of the live key `candidate` is, or null. Constant-time over the whole ring. */
  match(candidate: string, now?: number): string | null;
}

interface Entry {
  id: string;
  hash: Buffer;
  expiresAt: number | null;
}

/** Whether ANY key is configured — the bind policy's question, answerable without reading a file. */
export function hasAnyApiKey(security: Pick<SecurityConfig, 'apiKey' | 'apiKeyFile' | 'apiKeys'>): boolean {
  return Boolean(security.apiKey) || Boolean(security.apiKeyFile) || (security.apiKeys?.length ?? 0) > 0;
}

/** The sha256 of a key as lowercase hex — what `security.apiKeys[].keyHash` holds. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const HEX_64 = /^[0-9a-f]{64}$/i;

function readKeyFile(path: string, what: string, read: (path: string) => string): string {
  let raw: string;
  try {
    raw = read(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    throw new Error(`Cannot read ${what} "${path}" (${code}). The file's trimmed contents are the key; point it at a file this user can read.`);
  }
  const key = raw.trim();
  if (key.length === 0) throw new Error(`${what} "${path}" is empty. The file's trimmed contents are the key.`);
  return key;
}

function parseExpiry(value: string | undefined, id: string): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`security.apiKeys: key "${id}" has expiresAt ${JSON.stringify(value)}, which is not a date (use ISO 8601, e.g. 2026-12-31T00:00:00Z).`);
  }
  return ms;
}

/**
 * Build the ring from the config. Reads key files here, once, so a bad path
 * is a startup sentence rather than a 403 later. `read` is injectable for
 * tests.
 */
export function buildKeyRing(
  security: Pick<SecurityConfig, 'apiKey' | 'apiKeyFile' | 'apiKeys'>,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): KeyRing {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const add = (id: string, key: string, expiresAt: number | null): void => {
    if (seen.has(id)) throw new Error(`security.apiKeys: two keys carry the id "${id}"; ids must be unique (the single security.apiKey / IRIS_API_KEY is "${PRIMARY_KEY_ID}").`);
    seen.add(id);
    entries.push({ id, hash: createHash('sha256').update(key, 'utf8').digest(), expiresAt });
  };

  if (security.apiKey && security.apiKeyFile) {
    throw new Error(
      'security.apiKey (IRIS_API_KEY / --api-key) and security.apiKeyFile (IRIS_API_KEY_FILE) are both set — one primary key, from one place. Further keys go in security.apiKeys.',
    );
  }
  if (security.apiKey) add(PRIMARY_KEY_ID, security.apiKey, null);
  else if (security.apiKeyFile) add(PRIMARY_KEY_ID, readKeyFile(security.apiKeyFile, 'the API key file (IRIS_API_KEY_FILE / security.apiKeyFile)', read), null);

  for (const [index, entry] of (security.apiKeys ?? []).entries()) {
    const where = `security.apiKeys[${index}]`;
    if (typeof entry.id !== 'string' || entry.id.trim().length === 0) throw new Error(`${where}: every key needs a non-empty id.`);
    const id = entry.id.trim();
    const hasFile = typeof entry.keyFile === 'string' && entry.keyFile.length > 0;
    const hasHash = typeof entry.keyHash === 'string' && entry.keyHash.length > 0;
    if (hasFile === hasHash) {
      throw new Error(`${where} ("${id}"): set exactly one of keyFile (a file whose trimmed contents are the key) or keyHash (the sha256 hex of the key).`);
    }
    const expiresAt = parseExpiry(entry.expiresAt, id);
    if (hasHash) {
      if (!HEX_64.test(entry.keyHash as string)) throw new Error(`${where} ("${id}"): keyHash must be the sha256 of the key as 64 hex characters (openssl dgst -sha256).`);
      if (seen.has(id)) throw new Error(`security.apiKeys: two keys carry the id "${id}"; ids must be unique (the single security.apiKey / IRIS_API_KEY is "${PRIMARY_KEY_ID}").`);
      seen.add(id);
      entries.push({ id, hash: Buffer.from((entry.keyHash as string).toLowerCase(), 'hex'), expiresAt });
    } else {
      add(id, readKeyFile(entry.keyFile as string, `the key file for security.apiKeys "${id}"`, read), expiresAt);
    }
  }

  const builtAt = Date.now();
  return {
    empty: entries.length === 0,
    ids: entries.map((e) => e.id),
    expired: entries.filter((e) => e.expiresAt !== null && e.expiresAt <= builtAt).map((e) => e.id),
    match(candidate: string, now: number = Date.now()): string | null {
      const probe = createHash('sha256').update(candidate, 'utf8').digest();
      let found: string | null = null;
      // Every entry, every time: the compare must not say which key matched by how long it took.
      for (const entry of entries) {
        const equal = timingSafeEqual(probe, entry.hash);
        const live = entry.expiresAt === null || entry.expiresAt > now;
        if (equal && live && found === null) found = entry.id;
      }
      return found;
    },
  };
}
