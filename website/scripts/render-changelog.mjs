#!/usr/bin/env node
/*
 * Render CHANGELOG.md into src/lib/changelog.generated.json — the release
 * narrative the site's /releases page renders from.
 *
 * One source, no second copy to drift: the release page on GitHub is built
 * from the same file by scripts/changelog-section.mjs, the nav banner's
 * headline is the current section's bold lead (scripts/claims/generators/
 * release.mjs), and this file is the same section rendered as data. It is
 * deliberately not a build step: Vercel builds from a shallow clone, and a
 * committed artifact with a --check is what every other rendered surface
 * here does (page-dates.ts, llms.txt, mcp.json).
 *
 *   cd website && node scripts/render-changelog.mjs          # write
 *   cd website && node scripts/render-changelog.mjs --check  # exit 1 on drift
 *
 * Shape: { current: Release, history: ReleaseSummary[] } where a Release is
 * { version, date, lead, intro[], sections[{ title, items[] }] } — items are
 * the top-level bullets of a `###` section as markdown text, with their
 * nested lines appended — and a ReleaseSummary is { version, date, lead,
 * itemCount }. `lead` is the first bold span of the section, trailing
 * punctuation removed, exactly as release.mjs derives the headline.
 * Pre-releases (a version with a hyphen) are listed in the history and are
 * never `current`, matching release.mjs.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const website = resolve(here, '..');
const root = resolve(website, '..');
export const CHANGELOG_PATH = resolve(root, 'CHANGELOG.md');
export const OUTPUT_PATH = resolve(website, 'src', 'lib', 'changelog.generated.json');

const HEADER_RE = /^##\s*\[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\b\s*(.*)$/;
const SECTION_RE = /^###\s+(.+?)\s*$/;
const HEADLINE_RE = /^\*\*([^*\n]+?)\*\*/m;

function leadOf(text) {
  const h = text.match(HEADLINE_RE);
  if (!h) return null;
  return h[1].trim().replace(/[.:]+$/, '') || null;
}

/** Split the changelog into version sections, in file order. */
function sections(changelog) {
  const lines = changelog.split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(HEADER_RE);
    if (m) {
      // A heading may carry a note after the date (`[WITHDRAWN]`); it stays on the row.
      const note = m[3].replace(/^\[|\]$/g, '').trim();
      cur = { version: m[1], date: m[2], note: note || null, lines: [] };
      out.push(cur);
      continue;
    }
    if (/^##\s/.test(line)) {
      cur = null; // an Unreleased or foreign heading ends the section
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  return out;
}

/** The body of one version: intro paragraphs, then `###` sections of items. */
function parseBody(lines) {
  const intro = [];
  const sectionsOut = [];
  let section = null;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) intro.push(paragraph.join(' ').trim());
    paragraph = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const s = line.match(SECTION_RE);
    if (s) {
      flushParagraph();
      section = { title: s[1], items: [] };
      sectionsOut.push(section);
      continue;
    }
    if (section) {
      if (/^- /.test(line)) section.items.push(line.slice(2).trim());
      else if (line.trim() === '') continue;
      else if (section.items.length) section.items[section.items.length - 1] += `\n${line.trim()}`;
      else section.items.push(line.trim());
      continue;
    }
    if (line.trim() === '') flushParagraph();
    else if (/^\s*- /.test(line)) {
      flushParagraph();
      paragraph.push(line.trim());
    } else paragraph.push(line.trim());
  }
  flushParagraph();
  return { intro, sections: sectionsOut };
}

export function render(changelog) {
  const all = sections(changelog);
  if (all.length === 0) throw new Error('CHANGELOG.md carries no `## [x.y.z] - YYYY-MM-DD` section');
  const releases = all.map((s) => {
    const text = s.lines.join('\n');
    const body = parseBody(s.lines);
    const itemCount = body.sections.reduce((n, sec) => n + sec.items.length, 0);
    return { version: s.version, date: s.date, note: s.note, lead: leadOf(text), ...body, itemCount };
  });
  const current = releases.find((r) => !r.version.includes('-'));
  if (!current) throw new Error('CHANGELOG.md carries no production release');
  return {
    generatedFrom: 'CHANGELOG.md',
    current: { version: current.version, date: current.date, lead: current.lead, intro: current.intro, sections: current.sections },
    history: releases.map(({ version, date, note, lead, itemCount }) => ({ version, date, note, lead, itemCount })),
  };
}

export function renderToString(changelog) {
  return `${JSON.stringify(render(changelog), null, 2)}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const rendered = renderToString(readFileSync(CHANGELOG_PATH, 'utf-8'));
  if (check) {
    const committed = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, 'utf-8') : '';
    if (committed.replace(/\r\n/g, '\n') !== rendered) {
      console.error('[changelog:check] src/lib/changelog.generated.json is stale — run: cd website && node scripts/render-changelog.mjs');
      process.exit(1);
    }
    console.log('[changelog:check] OK — changelog.generated.json matches CHANGELOG.md');
    return;
  }
  writeFileSync(OUTPUT_PATH, rendered);
  const data = render(readFileSync(CHANGELOG_PATH, 'utf-8'));
  console.log(`[changelog:render] wrote src/lib/changelog.generated.json — current ${data.current.version}, ${data.history.length} releases`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
