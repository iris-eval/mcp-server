#!/usr/bin/env node
/*
 * Print one version's section of CHANGELOG.md, heading included.
 *
 *   node scripts/changelog-section.mjs 0.5.1
 *   node scripts/changelog-section.mjs 0.20.0 --fit 90000
 *
 * Used by .github/workflows/release.yml twice: the validate job runs it to
 * refuse a production tag that has no CHANGELOG entry, and the
 * github-release job runs it to build the release body. The section is the
 * ONLY place the "Check before upgrading" paragraph and the BREAKING entries
 * live, and v0.5.0's release page shipped without either because the page
 * was assembled from the PR list alone. Whatever is in the changelog is what
 * the release page says — one source, no second copy to drift.
 *
 * --fit <characters> is the release page's form. GitHub keeps a release body
 * to 125,000 characters and the release action cuts anything past that
 * without saying so, after appending GitHub's own list of merged pull
 * requests. A section that fits is printed whole. One that does not keeps,
 * in full, everything before its first `### ` heading (the summary and
 * "Check before upgrading", where every change a reader must act on lives),
 * then each later heading with each entry's lead sentence (its bold part),
 * and a link to the section in full. A section that does not fit even so is
 * an error, so the validate job refuses the tag before anything publishes.
 *
 * Exit 1 (nothing on stdout) when the section is missing or does not fit.
 * Callers decide whether a missing one is fatal (production tags) or a
 * fallback (pre-releases).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The section for `version` (or "Unreleased"), heading included, or null when CHANGELOG.md has none or it is empty. */
export function sectionOf(text, version) {
  const lines = text.split(/\r?\n/);
  // Keep a Changelog headings: `## [0.5.1] - 2026-09-03`. Match on the
  // bracketed version with plain string comparison — no regex built from input.
  const heading = `## [${version}]`;
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  if (end === -1) end = lines.length;
  const section = lines.slice(start, end).join('\n').trimEnd();
  return section.split('\n').length < 2 ? null : section;
}

/** The repository's web address, from package.json. */
export function repositoryUrl(dir = root) {
  const url = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8')).repository?.url ?? '';
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

/**
 * The section as the release page carries it within `limit` characters:
 * whole when it fits, otherwise condensed as described above. Null when even
 * the condensed form is longer than `limit`.
 */
export function fitSection(section, version, limit, repo = repositoryUrl()) {
  if (section.length <= limit) return section;
  const lines = section.split('\n');
  const first = lines.findIndex((l) => l.startsWith('### '));
  if (first === -1) return null;
  const out = [
    ...lines.slice(0, first),
    '',
    `Every entry below is shown by its lead sentence. The notes in full, with each entry's detail: [CHANGELOG.md at v${version}](${repo}/blob/v${version}/CHANGELOG.md).`,
  ];
  for (const line of lines.slice(first)) {
    if (line.startsWith('### ')) {
      out.push('', line, '');
      continue;
    }
    const lead = /^- (\*\*.+?\*\*)/.exec(line);
    if (lead) out.push(`- ${lead[1]}`);
  }
  const condensed = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return condensed.length <= limit ? condensed : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--fit');
  const limit = at === -1 ? undefined : Number(args[at + 1]);
  const version = args.find((a, i) => !a.startsWith('--') && (at === -1 || i !== at + 1));
  if (!version || (limit !== undefined && !(limit > 0))) {
    console.error('usage: node scripts/changelog-section.mjs <version> [--fit <characters>]');
    process.exit(2);
  }
  const section = sectionOf(readFileSync(resolve(root, 'CHANGELOG.md'), 'utf-8'), version);
  if (section === null) {
    console.error(`CHANGELOG.md has no non-empty "## [${version}]" section`);
    process.exit(1);
  }
  const body = limit === undefined ? section : fitSection(section, version, limit);
  if (body === null) {
    console.error(`CHANGELOG.md "## [${version}]" does not fit ${limit} characters even with every entry after the first ### heading cut to its lead sentence; shorten the summary or "Check before upgrading"`);
    process.exit(1);
  }
  process.stdout.write(body + '\n');
}
