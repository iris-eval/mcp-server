/*
 * The live key ring — revoking a key takes effect on the next request.
 *
 * buildKeyRing (keys.ts) reads the keys once. Until 0.20.0 the server built
 * it once at boot, so removing a leaked key from config.json, or deleting
 * its key file, did nothing until a restart: every request carrying it,
 * and every browser session opened with it, kept working.
 *
 * This ring wraps one built by buildKeyRing and watches what it was built
 * from: the config file and every key file it names (security.apiKeyFile,
 * security.apiKeys[].keyFile). Each question the auth layers ask it (match,
 * expiryOf, ids) first stats those files. That is a few `stat` calls per
 * request, no read, and no timer or file watcher to leak, miss an event on
 * a network filesystem, or keep the process alive. When any file's
 * modification time, change time, size or inode differs from what the
 * current ring was built from, the ring is rebuilt before the answer, so a
 * key removed from config.json, a key file deleted or rewritten, or a new
 * `expiresAt` applies to the very next request. The browser session layer
 * asks `expiryOf` on every request, so a removed key's sessions end then too.
 *
 * Deleting a key's file revokes that key alone: on a reload, a key whose
 * file no longer exists is left out of the ring and named in the log,
 * rather than refusing the reload. (At boot a missing key file still
 * refuses startup: there it is a mistake, not a revocation.)
 *
 * A reload that fails (config.json mid-edit and not valid JSON, a key file
 * that exists but is empty or unreadable, a duplicate id) fails CLOSED: the ring keeps only
 * the key given in IRIS_API_KEY or --api-key, which no file governs, and
 * logs why once per change. Keeping the previous ring instead would keep a
 * key alive that the operator just tried to revoke. The next change to the
 * files is tried again, so fixing the file restores the keys.
 *
 * What does not reload: whether auth is on at all. The middlewares decide
 * that from the ring at boot, and the bind policy was checked against it,
 * so a server started with keys never becomes open because its keys were
 * all removed (every request is refused instead), and a server started
 * without keys needs a restart to start requiring one. The other security
 * settings (origins, rate limits, allowUnauthenticated) also need a restart.
 */
import { statSync } from 'node:fs';
import { buildKeyRing, PRIMARY_KEY_ID, type KeyRing, type SecurityConfig } from './keys.js';

type KeySources = Pick<SecurityConfig, 'apiKey' | 'apiKeyFile' | 'apiKeys'>;

export interface LiveKeyRingOptions {
  /** The security block as it stands now (config/index.ts loadSecurityConfig). Throws on an invalid file. */
  load: () => KeySources;
  /** The config file the keys may come from; watched even while it does not exist. Null when there is none. */
  configPath: string | null;
  /** The key no file governs (IRIS_API_KEY / --api-key): all that survives a failed reload. */
  fixedApiKey?: string;
  /** Told about each reload, and about each failed one. */
  onReload?: (event: { ok: true; ids: readonly string[]; dropped: readonly string[] } | { ok: false; error: string }) => void;
  /** Injectable for tests: the file fingerprint and the key-file reader buildKeyRing uses. */
  fingerprint?: (path: string) => string;
  read?: (path: string) => string;
}

/** What changes when a file is edited, replaced or deleted. Missing is a state of its own. */
function statFingerprint(path: string): string {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.mtimeNs}:${s.ctimeNs}:${s.size}:${s.ino}`;
  } catch {
    return 'missing';
  }
}

function watchedPaths(configPath: string | null, security: KeySources): string[] {
  const paths = new Set<string>();
  if (configPath) paths.add(configPath);
  if (security.apiKeyFile) paths.add(security.apiKeyFile);
  for (const k of security.apiKeys ?? []) if (typeof k.keyFile === 'string' && k.keyFile.length > 0) paths.add(k.keyFile);
  return [...paths];
}

/** The security block without the keys whose file is gone, and the ids of those keys. */
function withoutMissingKeyFiles(security: KeySources, fingerprint: (path: string) => string): { security: KeySources; dropped: string[] } {
  const dropped: string[] = [];
  const gone = (path: string | undefined): boolean => typeof path === 'string' && path.length > 0 && fingerprint(path) === 'missing';
  let apiKeyFile = security.apiKeyFile;
  if (gone(apiKeyFile)) {
    dropped.push(PRIMARY_KEY_ID);
    apiKeyFile = undefined;
  }
  const apiKeys = (security.apiKeys ?? []).filter((k) => {
    if (!gone(k.keyFile)) return true;
    dropped.push(k.id);
    return false;
  });
  return { security: { ...security, apiKeyFile, apiKeys }, dropped };
}

/**
 * A KeyRing that rebuilds itself when its files change. `initial` is the
 * security block the server started with, already validated; building it
 * here throws exactly as buildKeyRing does, so a bad key at boot still
 * refuses startup with a sentence.
 */
export function createLiveKeyRing(initial: KeySources, opts: LiveKeyRingOptions): KeyRing {
  const fingerprint = opts.fingerprint ?? statFingerprint;
  const build = (security: KeySources): KeyRing => (opts.read ? buildKeyRing(security, opts.read) : buildKeyRing(security));

  let current = build(initial);
  let paths = watchedPaths(opts.configPath, initial);
  let seen = paths.map(fingerprint).join('|');

  function refresh(): KeyRing {
    const now = paths.map(fingerprint).join('|');
    if (now === seen) return current;
    // `now` was taken before anything is read, so an edit that lands during the reload differs from it next time.
    seen = now;
    try {
      const raw = opts.load();
      const loaded = withoutMissingKeyFiles(raw, fingerprint);
      const security = loaded.security;
      current = build(security);
      // Every file the config names, the removed ones too, so a key file put back is noticed.
      const next = watchedPaths(opts.configPath, raw);
      if (next.join('|') !== paths.join('|')) {
        paths = next;
        seen = paths.map(fingerprint).join('|');
      }
      opts.onReload?.({ ok: true, ids: current.ids, dropped: loaded.dropped });
    } catch (err) {
      // Fail closed: only the key no file governs. The watched paths stay as they were, so a fix is noticed.
      current = build({ apiKey: opts.fixedApiKey });
      opts.onReload?.({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return current;
  }

  return {
    // Whether auth is on is a boot-time fact (see the header); it does not follow reloads.
    empty: current.empty,
    get ids() {
      return refresh().ids;
    },
    get expired() {
      return refresh().expired;
    },
    match(candidate: string, now?: number): string | null {
      return refresh().match(candidate, now);
    },
    expiryOf(id: string): number | null | undefined {
      return refresh().expiryOf(id);
    },
  };
}
