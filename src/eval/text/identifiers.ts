/*
 * Locations an output cites, and locations the agent actually saw.
 *
 * This is the machinery behind `grounded_in_reads`, and its whole design is
 * one decision made early and then defended everywhere: A CLAIM IS A
 * LOCATION — a file, a directory or a URL — and nothing else.
 *
 * The tempting version is broader: code identifiers, versions, dates,
 * numbers, quoted strings. It is wrong twice over.
 *
 * Empirically: a pretrained agent legitimately knows a repository's symbol
 * table. Transcript t-12 names two REAL Iris environment variables that
 * appear in neither the ask nor any read, and under the broad taxonomy they
 * would be two false findings sitting beside the one true one.
 *
 * Architecturally, and this is the stronger reason: the risk estimate takes
 * a noisy-OR ACROSS failure classes and assumes those classes are
 * independent. Every one of those token types is ALREADY owned by a
 * `no_hallucination_markers` signal with its own calibrated exemption, in
 * class `fabrication`. Claiming them here too would put two correlated
 * detectors in two different classes and multiply them as if independent —
 * exactly the pair the proof harness has a correlation test to catch.
 *
 * A path is different in kind. There are four honest ways to know one: it
 * was in the ask, the agent read it, the agent created it, or it is world
 * knowledge. The first three are grounded below and the fourth is a closed
 * stoplist. That asymmetry between "a symbol I know" and "a path I can only
 * know by reading" IS the precision boundary.
 *
 * No regular expression scans a tool's output — the trajectory law — so the
 * scanner below is one hand-written forward pass used on ALL sources. That
 * is not only compliance: if the claim side and the ground side tokenised
 * differently, the rule would manufacture findings out of the mismatch.
 */

/** Longest run of token characters kept. Beyond it a run is a blob, not a citation. */
export const MAX_TOKEN_CHARS = 128;
/** Deepest path split. Bounds the segment n-gram expansion at 36 per path. */
export const MAX_PATH_SEGMENTS = 8;
/** Shortest tail prefix that may ground a claim. Three characters ground almost anything. */
export const TAIL_PREFIX_MIN = 4;

/**
 * File extensions, closed on purpose.
 *
 * The open-ended heuristic — "three or four lowercase characters after a
 * dot" — reads `Object.keys`, `array.some` and `res.end` as filenames. This
 * rule FIRES on what it finds, and a false extension is a false accusation,
 * so the list is enumerated for the same reason `sentences.ts` enumerates
 * its abbreviations.
 */
export const EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx', 'yml', 'yaml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sql', 'prisma', 'graphql',
  'proto', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'png', 'jpg', 'jpeg', 'gif',
  'webp', 'ico', 'pdf', 'csv', 'tsv', 'txt', 'log', 'lock', 'xml', 'plist', 'tf', 'tfvars',
  'gradle', 'mk', 'dockerfile', 'gitignore', 'npmrc', 'nvmrc', 'editorconfig', 'eslintrc',
  'prettierrc', 'babelrc', 'sqlite', 'db', 'zip', 'tar', 'gz', 'ipynb', 'vue', 'svelte',
]);

/**
 * Locations whose invention is not a defect.
 *
 * Naming `package.json` without reading it is not a fabrication, and firing
 * on it would make the rule unusable in every JavaScript repository on
 * earth. Bare hosts are here for the same reason: `github.com` is world
 * knowledge, while `github.com/owner/repo/blob/main/x.ts` is a citation.
 */
export const UBIQUITOUS: ReadonlySet<string> = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'readme.md', 'license', 'licence',
  'changelog.md', '.gitignore', '.env', '.env.example', 'dockerfile', 'docker-compose.yml',
  'makefile', 'node_modules', 'dist', 'build', 'src', 'test', 'tests', 'docs', 'lib', 'bin',
  'requirements.txt', 'pyproject.toml', 'cargo.toml', 'go.mod', 'pom.xml', 'index.html',
  'main.py', 'index.js', 'index.ts', 'setup.py', 'gemfile', 'composer.json', 'yarn.lock',
  'pnpm-lock.yaml', '.github/workflows/ci.yml', 'github.com', 'npmjs.com', 'stackoverflow.com',
  'developer.mozilla.org', 'docs.python.org', 'nodejs.org', 'www.npmjs.com', 'localhost',
]);

/**
 * Sentence frames in which naming a location is proposing it, not citing it.
 *
 * Deliberately over-broad, because every entry only ever SUPPRESSES a
 * finding. It mirrors the false-positive law `safety.ts` already states: an
 * agent introducing a new value is doing normal work, not contradicting a
 * source.
 */
export const PROPOSAL_MARKERS: readonly string[] = [
  'i would', "i'd ", 'we could', 'we should', 'you could', 'you should', 'i suggest',
  'i recommend', 'i propose', 'consider ', 'for example', 'e.g.', 'such as', 'something like',
  "let's ", 'next step', 'i will create', "i'll create", 'i created', "i've created",
  'i added', "i've added", 'i wrote', "i've written", 'create a', 'add a new', 'new file',
  'rename', 'renamed', 'move it to', 'save it to', 'write it to', 'output to', 'placeholder',
  'hypothetical', 'if you', 'once you', 'would be', 'could be', 'might be', 'typically',
  'conventionally', 'by convention', 'usually lives',
];

export type TokenClass = 'path' | 'filename' | 'url' | 'other';

export interface Token {
  /** As written, after punctuation trimming. */
  text: string;
  /** Lowercased, separators and query/fragment folded. */
  exact: string;
  /** `exact` with `_`, `-`, `.` and `/` removed — one variance class, folded away. */
  folded: string;
  cls: TokenClass;
  /** Path segments, when it is a path. */
  segments: readonly string[];
  /** Offsets into the string the scanner was given. */
  start: number;
  end: number;
}

const TOKEN_CHAR = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-./\\:@~+#$%'.split(''),
);
const LEAD_TRIM = new Set(['`', "'", '"', '(', '[', '{', '$', '<', '*', '>']);
const TAIL_TRIM = new Set(['`', "'", '"', ')', ']', '}', '>', ',', ';', ':', '!', '?', '*']);

function fold(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch !== '_' && ch !== '-' && ch !== '.' && ch !== '/') out += ch;
  }
  return out;
}

/**
 * Classify a trimmed run.
 *
 * Order matters: a URL is decided before slashes are treated as path
 * separators, and a two-segment run with no known extension is rejected so
 * that `and/or`, `input/output` and `read/write` are not filenames.
 */
export function classify(raw: string): { cls: TokenClass; exact: string; segments: string[] } {
  let text = raw;

  if (text.includes('://') || text.toLowerCase().startsWith('www.')) {
    const hash = text.indexOf('#');
    if (hash >= 0) text = text.slice(0, hash);
    const query = text.indexOf('?');
    if (query >= 0) text = text.slice(0, query);
    const lower = text.toLowerCase().replace(/\/+$/, '');
    const afterScheme = lower.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    // A bare host is world knowledge; a host with a path is a citation.
    const cls: TokenClass = afterScheme.includes('/') ? 'url' : 'other';
    return { cls, exact: lower, segments: [] };
  }

  text = text.replace(/\\/g, '/');
  if (text.startsWith('./')) text = text.slice(2);
  const absolute = text.startsWith('/');
  const trimmed = text.replace(/\/+$/, '');
  const lower = trimmed.toLowerCase();

  if (trimmed.includes('/')) {
    const segments = trimmed.split('/').filter((s) => s.length > 0);
    if (segments.length < 2 || segments.length > MAX_PATH_SEGMENTS) return { cls: 'other', exact: lower, segments: [] };
    if (!segments.every((s) => /^[A-Za-z0-9_.@~+-]+$/.test(s))) return { cls: 'other', exact: lower, segments: [] };
    // 03/15/1987, 24/7 and 50/50 are not paths.
    if (segments.every((s) => /^\d+$/.test(s))) return { cls: 'other', exact: lower, segments: [] };
    /*
     * A run whose first segment is an environment variable is a TEMPLATE,
     * not a location: `$IRIS_OTEL_ENDPOINT/v1/traces` describes how a URL is
     * composed and asserts nothing about a file existing. Found on t-12,
     * where the rule reported it beside a genuine invented filename — one
     * true finding and one piece of noise, and the noise had a shape.
     */
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(segments[0])) return { cls: 'other', exact: lower, segments: [] };
    const last = segments[segments.length - 1];
    const suffix = last.includes('.') ? last.slice(last.lastIndexOf('.') + 1).toLowerCase() : '';
    const known = EXTENSIONS.has(suffix);
    if (!known && segments.length < 3 && !absolute) return { cls: 'other', exact: lower, segments: [] };
    return { cls: 'path', exact: lower, segments };
  }

  const dot = trimmed.lastIndexOf('.');
  if (dot > 0 && dot < trimmed.length - 1) {
    const stem = trimmed.slice(0, dot);
    const suffix = trimmed.slice(dot + 1).toLowerCase();
    if (stem.length >= 2 && EXTENSIONS.has(suffix)) return { cls: 'filename', exact: lower, segments: [] };
  }
  return { cls: 'other', exact: lower, segments: [] };
}

/**
 * One forward pass. Linear by construction, no backtracking possible, and
 * used on the output, the input and every tool output alike.
 */
export function scanTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    if (!TOKEN_CHAR.has(text[i])) {
      i += 1;
      continue;
    }
    const runStart = i;
    while (i < text.length && TOKEN_CHAR.has(text[i])) i += 1;
    let start = runStart;
    let end = i;
    // A run longer than the cap is a blob or a minified line. Dropped on
    // BOTH sides, so a drop can never manufacture a finding.
    if (end - start > MAX_TOKEN_CHARS) continue;
    while (start < end && LEAD_TRIM.has(text[start])) start += 1;
    while (end > start && TAIL_TRIM.has(text[end - 1])) end -= 1;
    // A trailing dot goes only when the remainder still looks structured, so
    // `relevance.ts.` trims and `etc.` does not become `etc`.
    while (end > start && text[end - 1] === '.') {
      const body = text.slice(start, end - 1);
      if (!body.includes('.') && !body.includes('/')) break;
      end -= 1;
    }
    if (end - start < 2) continue;
    const raw = text.slice(start, end);
    const { cls, exact, segments } = classify(raw);
    tokens.push({ text: raw, exact, folded: fold(exact), cls, segments, start, end });
  }
  return tokens;
}

/** Every contiguous trailing segment sequence of a path, longest first. */
export function pathSuffixes(segments: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 1; k < segments.length; k += 1) out.push(segments.slice(k).join('/'));
  return out;
}

/**
 * The ground index: every key a claim may match against.
 *
 * Paths also insert every contiguous segment n-gram, because "the agent
 * composed the directory it listed with the filename it saw" is normal,
 * correct behaviour and would otherwise be this rule's dominant false
 * positive. That is permissive in one direction — a `reference.md` read
 * anywhere grounds `docs/api/reference.md` — and that is the safe direction.
 */
export function indexGround(tokens: readonly Token[], into: Set<string>): void {
  for (const t of tokens) {
    into.add(t.exact);
    into.add(t.folded);
    if (t.cls === 'path') {
      for (const suffix of pathSuffixes(t.segments)) {
        const lower = suffix.toLowerCase();
        into.add(lower);
        into.add(fold(lower));
      }
    }
  }
}

/**
 * Is this claim one whose invention is not a defect?
 *
 * Checks the trailing segments too, not just the whole path. `src/index.ts`
 * is as ubiquitous as `index.ts`, and a reader told "the entry point is
 * src/index.ts" by an agent that read package.json would call that a
 * reasonable inference rather than a fabrication. Found by the corpus: the
 * rule fired on exactly that case and the label was right.
 *
 * The named cost, in the safe direction: an invented DIRECTORY ending in a
 * ubiquitous filename — `made/up/index.ts` — is missed. This rule is
 * precision-first, so a miss is the failure it prefers.
 */
export function isUbiquitous(token: Token): boolean {
  if (UBIQUITOUS.has(token.exact) || UBIQUITOUS.has(token.folded)) return true;
  if (token.cls !== 'path') return false;
  return pathSuffixes(token.segments).some((suffix) => UBIQUITOUS.has(suffix.toLowerCase()));
}

/** Is this claim covered by the ground set, allowing a suffix or a cut-off tail? */
export function isGrounded(claim: Token, ground: ReadonlySet<string>, tailPrefixes: readonly string[]): boolean {
  if (ground.has(claim.exact) || ground.has(claim.folded)) return true;
  if (claim.cls === 'path') {
    for (const suffix of pathSuffixes(claim.segments)) {
      const lower = suffix.toLowerCase();
      if (ground.has(lower) || ground.has(fold(lower))) return true;
    }
  }
  // A read that stopped mid-stream stopped mid-token, so the last token of
  // each output grounds anything it is a prefix of. This is what keeps a
  // control transcript passing when its tool output was cut at 600 bytes.
  for (const prefix of tailPrefixes) {
    if (prefix.length >= TAIL_PREFIX_MIN && claim.folded.startsWith(prefix)) return true;
  }
  return false;
}

/** Sentence spans of `text` whose lowercase carries a proposal marker. */
export function proposalSpans(text: string, sentences: readonly string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const sentence of sentences) {
    const at = text.indexOf(sentence, cursor);
    if (at < 0) continue;
    cursor = at + sentence.length;
    const lower = sentence.toLowerCase();
    if (PROPOSAL_MARKERS.some((m) => lower.includes(m))) spans.push([at, cursor]);
  }
  return spans;
}

export function insideAny(spans: ReadonlyArray<[number, number]>, start: number, end: number): boolean {
  return spans.some(([a, b]) => start >= a && end <= b);
}
