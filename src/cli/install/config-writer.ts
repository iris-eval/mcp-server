/*
 * Config writer — adds the Iris MCP server entry to a client's config, and
 * takes it out again.
 *
 * Strategies (see ClientProfile.configMode):
 *   - dedicated-mcp-json: file is { mcpServers: {...} }. Create if missing;
 *     merge if it exists. Iris becomes one entry alongside whatever the user
 *     already had.
 *   - embedded-in-config-json: file is a larger config with many top-level
 *     fields (~/.claude.json). Add or update mcpServers without disturbing
 *     the other fields.
 *   - vscode-servers: file is { servers: {...} } (VS Code's native MCP
 *     schema — "servers", not "mcpServers").
 *   - zed-context-servers: Zed settings.json — MCP lives under
 *     "context_servers", one entry per server with `command`, `args` and
 *     `env` at its top level.
 *   - codex-toml: config.toml — an [mcp_servers.iris-eval] table. No TOML
 *     dependency: the table is found by its header and only its `command` and
 *     `args` lines are ever rewritten.
 *
 * JSON files are edited as text (./jsonc.ts): the Iris member is inserted,
 * replaced or cut and every other byte stays — comments (Zed writes its
 * settings file with a comment header; VS Code and Gemini CLI accept them),
 * key order, indentation, line endings. Each edit is checked before it is
 * written: the file is parsed again and must equal the original with only
 * the Iris entry changed, or nothing is written.
 *
 * The launch line is pinned: `npx -y @iris-eval/mcp-server@<version>`, the
 * version of the package doing the install, so a client keeps running what
 * was installed instead of whatever npm calls latest on its next start (the
 * plugins and the gate action pin the same way). Running install again from
 * a newer release moves the pin — that is the upgrade path.
 *
 * Re-running is safe. An entry that already says exactly this is left alone
 * (no-change). An existing Iris entry is updated in place: its command and
 * launch arguments become ours, and everything the user added is kept —
 * other keys on the entry (`env`, a `disabled` flag) and any arguments after
 * the package, such as `--dashboard`. Uninstall removes only the Iris entry;
 * other servers stay.
 *
 * The entry KEY is `iris-eval` — the same name every other Iris install
 * surface uses (the README's paste-in configs, .well-known/mcp.json, the
 * Cursor deeplink, the Claude Code plugin). An earlier installer wrote
 * `iris`, so a user who installed both ways had TWO live entries spawning two
 * servers and duplicate tool names in the agent's tool list, and uninstall
 * removed only one of them. Install migrates a legacy `iris` entry to
 * `iris-eval` (one entry, not two), and uninstall removes both keys.
 *
 * Writes are atomic (temp file + rename), keep the file's permissions, and
 * follow a symlinked config to the file it points at, so a dotfiles checkout
 * stays a symlink.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { writeAtomic } from '../../utils/write-atomic.js';
import { IRIS_PACKAGE, type ClientProfile, type ConfigMode, type LaunchCommand } from './clients.js';
import { detectStyle, JsoncError, memberOf, parseTree, removeMember, setMember, valueOf, type Node, type ObjectNode } from './jsonc.js';

/** The canonical server key, shared with every other Iris install surface. */
export const IRIS_SERVER_KEY = 'iris-eval';
/** The key an earlier installer wrote. Migrated on install, removed on uninstall. */
export const LEGACY_IRIS_SERVER_KEY = 'iris';

export interface InstallResult {
  configPath: string;
  action: 'created' | 'updated' | 'no-change';
  /** Something the user should know about the file, e.g. an entry left alone. */
  note?: string;
}

export interface UninstallResult {
  configPath: string;
  action: 'removed' | 'not-present';
  note?: string;
}

type Json = Record<string, unknown>;

/* ---------------- Files ---------------- */

/** The file a write lands on: a symlinked config is written through, not replaced. */
function writeTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** What a file the installer creates gets: the mode a client's own ordinary write would give it. */
const NEW_FILE_MODE = 0o644;

function modeOf(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return NEW_FILE_MODE;
  }
}

interface TextFile {
  exists: boolean;
  /** Without a leading byte-order mark. */
  text: string;
  bom: boolean;
}

function readText(path: string): TextFile {
  if (!existsSync(path)) return { exists: false, text: '', bom: false };
  const raw = readFileSync(path, 'utf-8');
  const bom = raw.charCodeAt(0) === 0xfeff;
  return { exists: true, text: bom ? raw.slice(1) : raw, bom };
}

function writeText(path: string, file: TextFile, text: string): void {
  writeAtomic(writeTarget(path), (file.bom ? '\ufeff' : '') + text, modeOf(path));
}

/* ---------------- Entry merging ---------------- */

const PACKAGE_ARG = new RegExp(`^${IRIS_PACKAGE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?:@.+)?$`);

/** Arguments the user added after the package spec (e.g. `--dashboard`); kept across re-installs. */
function trailingArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  const at = args.findIndex((a) => typeof a === 'string' && PACKAGE_ARG.test(a));
  return at === -1 ? [] : args.slice(at + 1).filter((a): a is string => typeof a === 'string');
}

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function launchKeys(launch: LaunchCommand, trailing: string[]): Json {
  return { command: launch.command, args: [...launch.args, ...trailing] };
}

/** The entry a fresh install writes for this client. */
export function entryFor(profile: Pick<ClientProfile, 'configMode' | 'entryType'>, launch: LaunchCommand): Json {
  const type = profile.entryType ? { type: profile.entryType } : {};
  // Zed's documented entry carries `env` alongside `command` and `args`.
  return profile.configMode === 'zed-context-servers' ? { ...type, ...launchKeys(launch, []), env: {} } : { ...type, ...launchKeys(launch, []) };
}

/**
 * The entry to write, given what is there now: a fresh entry, or the
 * existing one with only its launch keys changed. An entry in Zed's retired
 * nested shape (`command: { path, args }`) becomes the documented flat one.
 */
function mergeEntry(current: unknown, profile: Pick<ClientProfile, 'configMode' | 'entryType'>, launch: LaunchCommand): Json {
  if (!isRecord(current)) return entryFor(profile, launch);
  const nested = isRecord(current.command) ? current.command : undefined;
  const trailing = trailingArgs(nested ? nested.args : current.args);
  // A client that requires `type` gets it on an older entry that lacks one; a type already there is the user's.
  const type = profile.entryType && current.type === undefined ? { type: profile.entryType } : {};
  return { ...type, ...current, ...launchKeys(launch, trailing) };
}

/** Deterministic serialisation, key order ignored — for "did anything change" and the edit check. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The command words that mean an entry starts Iris: the package, or a bin it installs. */
const IRIS_COMMAND_WORDS = [IRIS_PACKAGE, IRIS_SERVER_KEY, 'iris-mcp'];

/**
 * Whether a command and its arguments start Iris. The key `iris` is only a
 * name: older Iris docs used it, but so can any other server, so an entry
 * under it is ours only when what it runs is Iris.
 */
export function startsIris(command: unknown, args: unknown): boolean {
  const words = [command, ...(Array.isArray(args) ? args : [])].filter((w): w is string => typeof w === 'string');
  return words.some((word) => {
    const base = word.replace(/\\/g, '/').split('/').pop()!.replace(/\.(?:cmd|exe|js)$/i, '');
    return IRIS_COMMAND_WORDS.some((name) => word === name || word.startsWith(`${name}@`) || base === name);
  });
}

/** Whether a JSON entry under the legacy key is an Iris entry (either entry shape). */
function isIrisEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const nested = isRecord(value.command) ? value.command : undefined;
  return nested ? startsIris(nested.path, nested.args) : startsIris(value.command, value.args);
}

function legacyLeftAlone(path: string): string {
  return `An entry named "${LEGACY_IRIS_SERVER_KEY}" in ${path} does not start Iris, so it was left as it is.`;
}

/** The map without the Iris entries: the current key always, the legacy key only when it is Iris. */
function withoutIris(map: Json, legacyIsIris: boolean): Json {
  const { [IRIS_SERVER_KEY]: _current, ...rest } = map;
  void _current;
  if (!legacyIsIris) return rest;
  const { [LEGACY_IRIS_SERVER_KEY]: _legacy, ...others } = rest;
  void _legacy;
  return others;
}

/* ---------------- JSON strategies (mcpServers / servers / context_servers) ---------------- */

type MapKey = 'mcpServers' | 'servers' | 'context_servers';

function mapKeyFor(mode: ConfigMode): MapKey {
  if (mode === 'vscode-servers') return 'servers';
  if (mode === 'zed-context-servers') return 'context_servers';
  return 'mcpServers';
}

function parseConfig(path: string, text: string): ObjectNode {
  let root: Node;
  try {
    root = parseTree(text);
  } catch (err) {
    const detail = err instanceof JsoncError ? err.message : String(err);
    throw new Error(`Failed to parse existing config at ${path}: ${detail}. Fix the syntax and retry; the file was not changed.`);
  }
  if (root.kind !== 'object') throw new Error(`The config at ${path} is not a JSON object; the file was not changed.`);
  return root;
}

/** The server map node, or undefined when the key is absent. Refuses a map key that holds something other than an object. */
function mapNode(path: string, root: ObjectNode, key: MapKey): ObjectNode | undefined {
  const member = memberOf(root, key);
  if (!member) return undefined;
  if (member.value.kind !== 'object') throw new Error(`"${key}" in ${path} is not an object; the file was not changed.`);
  return member.value;
}

/**
 * Refuse to write an edit that changed anything but the Iris entries: the
 * result must parse and equal the original with `key` replaced by `expected`.
 */
function checkEdit(path: string, before: string, after: string, key: MapKey, expected: Json): void {
  const was = valueOf(before, parseTree(before)) as Json;
  let now: unknown;
  try {
    now = valueOf(after, parseTree(after));
  } catch (err) {
    throw new Error(`Refusing to write ${path}: the edited file would not parse (${(err as Error).message}). The file was not changed.`);
  }
  if (canonical(now) !== canonical({ ...was, [key]: expected })) {
    throw new Error(`Refusing to write ${path}: the edit would change more than the ${IRIS_SERVER_KEY} entry. The file was not changed.`);
  }
}

function installJson(profile: ClientProfile, launch: LaunchCommand): InstallResult {
  const path = profile.configPath;
  const key = mapKeyFor(profile.configMode);
  const file = readText(path);

  if (!file.exists || file.text.trim() === '') {
    const text = JSON.stringify({ [key]: { [IRIS_SERVER_KEY]: entryFor(profile, launch) } }, null, 2) + '\n';
    writeText(path, file, text);
    return { configPath: path, action: 'created' };
  }

  const style = detectStyle(file.text);
  const root = parseConfig(path, file.text);
  const map = mapNode(path, root, key);
  const currentMember = map ? memberOf(map, IRIS_SERVER_KEY) : undefined;
  const legacyAny = map ? memberOf(map, LEGACY_IRIS_SERVER_KEY) : undefined;
  const legacyMember = legacyAny && isIrisEntry(valueOf(file.text, legacyAny.value)) ? legacyAny : undefined;
  const note = legacyAny && !legacyMember ? legacyLeftAlone(path) : undefined;
  const existing = currentMember ?? legacyMember;
  const current = existing ? valueOf(file.text, existing.value) : undefined;
  const next = mergeEntry(current, profile, launch);

  if (currentMember && !legacyMember && canonical(current) === canonical(next)) {
    return { configPath: path, action: 'no-change', ...(note ? { note } : {}) };
  }

  let text = file.text;
  if (!map) {
    text = setMember(text, root, key, { [IRIS_SERVER_KEY]: next }, style);
  } else {
    // The legacy entry goes first (a migration, or a duplicate from installing two ways).
    if (legacyMember) text = removeMember(text, map, LEGACY_IRIS_SERVER_KEY);
    text = setMember(text, mapNode(path, parseConfig(path, text), key)!, IRIS_SERVER_KEY, next, style);
  }

  const others = map ? withoutIris(valueOf(file.text, map) as Json, Boolean(legacyMember)) : {};
  checkEdit(path, file.text, text, key, { ...others, [IRIS_SERVER_KEY]: next });
  writeText(path, file, text);
  return { configPath: path, action: existing ? 'updated' : 'created', ...(note ? { note } : {}) };
}

function uninstallJson(profile: ClientProfile): UninstallResult {
  const path = profile.configPath;
  const key = mapKeyFor(profile.configMode);
  const file = readText(path);
  if (!file.exists || file.text.trim() === '') return { configPath: path, action: 'not-present' };

  const root = parseConfig(path, file.text);
  const map = mapNode(path, root, key);
  const legacyAny = map ? memberOf(map, LEGACY_IRIS_SERVER_KEY) : undefined;
  const legacyIsIris = Boolean(legacyAny && isIrisEntry(valueOf(file.text, legacyAny.value)));
  const note = legacyAny && !legacyIsIris ? legacyLeftAlone(path) : undefined;
  if (!map || (!memberOf(map, IRIS_SERVER_KEY) && !legacyIsIris)) {
    return { configPath: path, action: 'not-present', ...(note ? { note } : {}) };
  }

  let text = file.text;
  for (const k of legacyIsIris ? [IRIS_SERVER_KEY, LEGACY_IRIS_SERVER_KEY] : [IRIS_SERVER_KEY]) {
    text = removeMember(text, mapNode(path, parseConfig(path, text), key)!, k);
  }
  checkEdit(path, file.text, text, key, withoutIris(valueOf(file.text, map) as Json, legacyIsIris));
  writeText(path, file, text);
  return { configPath: path, action: 'removed', ...(note ? { note } : {}) };
}

/* ---------------- Codex strategy (TOML table) ---------------- */

const CODEX_TABLE = `mcp_servers.${IRIS_SERVER_KEY}`;
const CODEX_LEGACY_TABLE = `mcp_servers.${LEGACY_IRIS_SERVER_KEY}`;

function tomlArray(items: string[]): string {
  return `[${items.map((s) => JSON.stringify(s)).join(', ')}]`;
}

/** The dotted name inside a `[table]` (or `[[array]]`) header line; null for any other line. */
function headerName(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith('[')) return null;
  const open = t.startsWith('[[') ? 2 : 1;
  const close = t.indexOf(open === 2 ? ']]' : ']', open);
  if (close === -1) return null;
  const rest = t.slice(close + open).trim();
  if (rest !== '' && !rest.startsWith('#')) return null;
  return t
    .slice(open, close)
    .split('.')
    .map((part) => {
      const p = part.trim();
      return p.length >= 2 && p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
    })
    .join('.');
}

/**
 * For each line of `raw`, whether it starts inside a TOML multi-line string
 * ("""…""" or '''…'''). A header-like line there is the user's text, not
 * a table, so the scanners below skip it.
 */
function insideMultilineString(raw: string): boolean[] {
  const inside: boolean[] = [];
  let open: '"""' | "'''" | null = null;
  for (const line of raw.split('\n')) {
    inside.push(open !== null);
    let i = 0;
    while (i < line.length) {
      if (open) {
        const close = line.indexOf(open, i);
        if (close === -1) break;
        i = close + 3;
        open = null;
        continue;
      }
      const c = line[i];
      if (c === '#') break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        open = line.slice(i, i + 3) as '"""' | "'''";
        i += 3;
      } else if (c === '"') {
        i++;
        while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
        i++;
      } else if (c === "'") {
        const close = line.indexOf("'", i + 1);
        i = close === -1 ? line.length : close + 1;
      } else {
        i++;
      }
    }
  }
  return inside;
}

interface TableSpan {
  start: number;
  end: number;
  /** The table itself, not one of its sub-tables. */
  main: boolean;
}

/**
 * Every span that belongs to a table: its own section (header up to the next
 * header) and each of its sub-tables (`[mcp_servers.iris-eval.env]`), so an
 * uninstall never leaves an orphaned `env` table behind to become an entry
 * with no command.
 */
function tableSpans(raw: string, name: string): TableSpan[] {
  const spans: TableSpan[] = [];
  const inString = insideMultilineString(raw);
  let offset = 0;
  let open: TableSpan | null = null;
  for (const [index, line] of raw.split('\n').entries()) {
    const header = inString[index] ? null : headerName(line);
    if (header !== null) {
      if (open) {
        spans.push({ ...open, end: offset });
        open = null;
      }
      if (header === name || header.startsWith(`${name}.`)) open = { start: offset, end: raw.length, main: header === name };
    }
    offset += line.length + 1;
  }
  if (open) spans.push({ ...open, end: raw.length });
  return spans;
}

/** Remove a table and its sub-tables; blank lines change only at the seams they leave. */
function removeTables(raw: string, name: string): string {
  let out = raw;
  for (const span of tableSpans(raw, name).reverse()) {
    const before = out.slice(0, span.start).replace(/\n+$/, '\n');
    const after = out.slice(span.end).replace(/^\n+/, '');
    out = before === '\n' || before === '' ? after : after === '' ? before : `${before}\n${after}`;
  }
  return out;
}

interface KeySpan {
  /** Where the key's line starts. */
  start: number;
  /** Just past the value (for an array, its closing bracket). */
  end: number;
  /** The string items, for an array value. */
  items: string[];
}

/**
 * Find `key = <value>` at the start of a line in one table's text: a
 * one-line value, or an array that may run over several lines, read item by
 * item with TOML's basic ("…") and literal ('…') strings. A scan rather than
 * a regular expression, so a malformed array cannot make it backtrack.
 */
function findKey(body: string, key: string): KeySpan | null {
  let offset = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(key) && trimmed.slice(key.length).trimStart().startsWith('=')) {
      const start = offset;
      let i = offset + (line.length - trimmed.length) + key.length;
      while (body[i] === ' ' || body[i] === '\t') i++;
      i++; // past "="
      while (body[i] === ' ' || body[i] === '\t') i++;
      if (body[i] !== '[') return { start, end: offset + line.length, items: [] };
      const items: string[] = [];
      i++;
      while (i < body.length && body[i] !== ']') {
        const c = body[i];
        if (c === '"') {
          let j = i + 1;
          while (j < body.length && body[j] !== '"') j += body[j] === '\\' ? 2 : 1;
          items.push(JSON.parse(body.slice(i, j + 1)) as string);
          i = j + 1;
        } else if (c === "'") {
          const j = body.indexOf("'", i + 1);
          if (j === -1) return null;
          items.push(body.slice(i + 1, j));
          i = j + 1;
        } else if (c === '#') {
          while (i < body.length && body[i] !== '\n') i++;
        } else {
          i++;
        }
      }
      return i < body.length ? { start, end: i + 1, items } : null;
    }
    offset += line.length + 1;
  }
  return null;
}

/** Replace `key = …` in a table's text, or add the line after `afterLine` (a line already in the table). */
function setKey(body: string, key: string, line: string, afterLine: string): string {
  const found = findKey(body, key);
  if (found) return body.slice(0, found.start) + line + body.slice(found.end);
  const lineEnd = body.indexOf('\n', body.indexOf(afterLine));
  return lineEnd === -1 ? `${body}\n${line}` : `${body.slice(0, lineEnd + 1)}${line}\n${body.slice(lineEnd + 1)}`;
}

/** The string value of `key = "…"` (or '…') in a table's text; undefined when absent or not a plain string. */
function stringKey(body: string, key: string): string | undefined {
  const found = findKey(body, key);
  if (!found || found.items.length > 0) return undefined;
  const value = body.slice(found.start, found.end).split('=').slice(1).join('=').trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
    return value[0] === '"' ? (JSON.parse(value) as string) : value.slice(1, -1);
  }
  return undefined;
}

/** Whether the table at `span` starts Iris. */
function codexTableIsIris(raw: string, span: TableSpan): boolean {
  const body = raw.slice(span.start, span.end);
  return startsIris(stringKey(body, 'command'), findKey(body, 'args')?.items ?? []);
}

/**
 * A server under `name` written in a TOML form other than its own
 * `[mcp_servers.<name>]` header: a key inside `[mcp_servers]`
 * (`iris-eval = { … }`, `"iris-eval".command = …`), or a dotted key from the
 * root or another table (`mcp_servers.iris-eval.command = …`). The installer
 * edits only the header form, so it refuses rather than add a second
 * definition, which TOML forbids.
 */
function otherTomlForm(raw: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inTable = new RegExp(`^(?:"${escaped}"|'${escaped}'|${escaped})\\s*[=.]`);
  const dotted = new RegExp(`^mcp_servers\\s*\\.\\s*(?:"${escaped}"|'${escaped}'|${escaped})\\s*[=.]`);
  const inString = insideMultilineString(raw);
  let table = '';
  for (const [index, line] of raw.split('\n').entries()) {
    if (inString[index]) continue;
    const header = headerName(line);
    if (header !== null) {
      table = header;
      continue;
    }
    const t = line.trim();
    if ((table === 'mcp_servers' && inTable.test(t)) || dotted.test(t)) return true;
  }
  return false;
}

function refuseOtherForm(path: string, raw: string): void {
  for (const name of [IRIS_SERVER_KEY, LEGACY_IRIS_SERVER_KEY]) {
    if (otherTomlForm(raw, name)) {
      throw new Error(
        `${path} defines "${name}" under mcp_servers in a form other than a [mcp_servers.${name}] table, which install does not edit. ` +
          `Move it to a [mcp_servers.${name}] table, or remove it, and run install again. The file was not changed.`,
      );
    }
  }
}

function installCodex(profile: ClientProfile, launch: LaunchCommand): InstallResult {
  const path = profile.configPath;
  const file = readText(path);
  const crlf = file.text.includes('\r\n');
  const raw = file.text.replace(/\r\n/g, '\n');
  refuseOtherForm(path, raw);

  const own = tableSpans(raw, CODEX_TABLE).find((s) => s.main);
  const legacyAny = tableSpans(raw, CODEX_LEGACY_TABLE).find((s) => s.main);
  const legacy = legacyAny && codexTableIsIris(raw, legacyAny) ? legacyAny : undefined;
  const note = legacyAny && !legacy ? legacyLeftAlone(path) : undefined;
  let next: string;

  if (own || legacy) {
    // Update the existing table in place: only its header, command and args lines move.
    const span = (own ?? legacy)!;
    const body = raw.slice(span.start, span.end);
    const trailing = trailingArgs(findKey(body, 'args')?.items ?? []);
    const header = `[${CODEX_TABLE}]`;
    const commandLine = `command = ${JSON.stringify(launch.command)}`;
    const argsLine = `args = ${tomlArray([...launch.args, ...trailing])}`;
    const firstBreak = body.indexOf('\n');
    let table = header + (firstBreak === -1 ? '' : body.slice(firstBreak));
    table = setKey(table, 'command', commandLine, header);
    table = setKey(table, 'args', argsLine, commandLine);
    next = raw.slice(0, span.start) + table + raw.slice(span.end);
    if (own && legacy) {
      // A table under each key (installed two ways): the legacy one goes.
      next = removeTables(next, CODEX_LEGACY_TABLE);
    } else if (legacy) {
      // A migrated table's sub-tables move with it.
      next = next.replace(/^\[mcp_servers\.(?:"iris"|'iris'|iris)\./gm, `[${CODEX_TABLE}.`);
    }
  } else {
    const table = `[${CODEX_TABLE}]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${tomlArray(launch.args)}\n`;
    next = raw.length === 0 || raw.endsWith('\n\n') ? raw + table : raw.endsWith('\n') ? raw + '\n' + table : raw + '\n\n' + table;
  }

  const extra = note ? { note } : {};
  if (next === raw) return { configPath: path, action: 'no-change', ...extra };
  writeText(path, file, crlf ? next.replace(/\n/g, '\r\n') : next);
  return { configPath: path, action: own || legacy ? 'updated' : 'created', ...extra };
}

function uninstallCodex(profile: ClientProfile): UninstallResult {
  const path = profile.configPath;
  const file = readText(path);
  if (!file.exists) return { configPath: path, action: 'not-present' };
  const crlf = file.text.includes('\r\n');
  const raw = file.text.replace(/\r\n/g, '\n');
  refuseOtherForm(path, raw);
  const legacyAny = tableSpans(raw, CODEX_LEGACY_TABLE).find((s) => s.main);
  const legacyIsIris = Boolean(legacyAny && codexTableIsIris(raw, legacyAny));
  const extra = legacyAny && !legacyIsIris ? { note: legacyLeftAlone(path) } : {};
  if (tableSpans(raw, CODEX_TABLE).length === 0 && !legacyIsIris) {
    return { configPath: path, action: 'not-present', ...extra };
  }
  // Only the Iris tables are removed — the current key, and the legacy key when it is Iris, with their sub-tables.
  const withoutCurrent = removeTables(raw, CODEX_TABLE);
  const next = legacyIsIris ? removeTables(withoutCurrent, CODEX_LEGACY_TABLE) : withoutCurrent;
  writeText(path, file, crlf ? next.replace(/\n/g, '\r\n') : next);
  return { configPath: path, action: 'removed', ...extra };
}

/* ---------------- Dispatch ---------------- */

export function installIris(profile: ClientProfile, launch: LaunchCommand): InstallResult {
  return profile.configMode === 'codex-toml' ? installCodex(profile, launch) : installJson(profile, launch);
}

export function uninstallIris(profile: ClientProfile): UninstallResult {
  return profile.configMode === 'codex-toml' ? uninstallCodex(profile) : uninstallJson(profile);
}
