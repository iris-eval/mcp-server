/*
 * Every compare cell's quote, checked against its page (arc 9, N-21).
 *
 * Each vendor file under website/src/lib/compare/ carries, per row, the
 * URL the cell was read from and the sentence read there. This script
 * downloads each page plainly (no browser) and reads it the way a reader
 * would: tags gone, entities decoded, and — because the docs sites of most
 * vendors answer a plain fetch with Markdown — inline Markdown markup gone
 * too (link brackets, backticks, bold, heading marks), the spacing that
 * stripped tags leave before punctuation folded, whitespace folded. That is
 * the method index.ts documents for `quoteVerified`, and it says whether the
 * quote is on the page today. Writes nothing unless `--write`, which sets
 * `quoteVerified` and `quotesCheckedOn` from what it found; a page that
 * refused the fetch (403, 429, a timeout) leaves the cell as it was and is
 * named, never counted as a miss.
 *
 *   npm run compare:verify                       # report
 *   npm run compare:verify -- --write            # record
 *   npm run compare:verify -- --only weave       # one vendor
 *
 * tests/compare-quote-verifier.test.ts holds the reading.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'website', 'src', 'lib', 'compare');
const write = process.argv.includes('--write');
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;
const today = new Date().toISOString().slice(0, 10);
const UA = 'Mozilla/5.0 (compatible; iris-eval compare-quote check; +https://iris-eval.com/compare)';

/** Inline Markdown markup gone: a page served as Markdown reads as its words. */
function unmarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // an image: its alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // a link: its text
    .replace(/`+/g, '')
    .replace(/\*\*/g, '')
    .replace(/(^|\s)#{1,6}\s+/g, '$1') // a heading mark
    .replace(/(^|\s)_([^_\s][^_]*?)_(?=[\s.,;:!?)]|$)/g, '$1$2'); // _emphasis_ around a phrase, never inside an identifier
}

/** The spacing a stripped tag leaves around punctuation, closed: "Java , Go" reads "Java, Go". */
function closePunctuation(text) {
  return text.replace(/\s+([,.;:!?)\]])/g, '$1').replace(/([(\[])\s+/g, '$1');
}

/** The page as a reader would see its words: tags gone, entities decoded, Markdown markup gone, whitespace folded, case kept. */
export function plainText(html) {
  return unmarkdown(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, ' ') // the block, to its closing tag however that tag is written
      .replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<![^>]*>/g, ' ') // a doctype
      .replace(/<\/?[a-zA-Z][^>]*>/g, ' ') // a tag starts with a letter; "<5ms" in a table is text
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;|&lsquo;|&rsquo;/g, "'")
      .replace(/&ldquo;|&rdquo;/g, '"')
      .replace(/&ndash;|&mdash;/g, '-')
      .replace(/&hellip;/g, '…')
      .replace(/&amp;/g, '&') // last, so an escaped entity is decoded once, never twice
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"'),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** The same folding on both sides: quotes and dashes normalised, Markdown markup gone, punctuation closed up, whitespace folded — so typography and a tag boundary never decide. */
export function fold(text) {
  return closePunctuation(
    unmarkdown(
      text
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, '-'),
    ),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function quoteOnPage(quote, page) {
  const q = fold(quote);
  if (q.length === 0) return false;
  return fold(page).includes(q);
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,text/markdown,text/plain,*/*' }, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error && err.name === 'AbortError' ? 'timeout' : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !only || f === `${only}.json`)
    .sort();
  const pages = new Map();
  const totals = { found: 0, missing: 0, unreachable: 0, notStated: 0, flipped: 0 };
  const misses = [];
  const refused = new Set();
  for (const file of files) {
    const path = join(dir, file);
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    let changed = false;
    for (const row of data.rows) {
      if (row.quoteVerified === null || /Not stated in the vendor/.test(row.vendor)) {
        totals.notStated += 1;
        continue;
      }
      if (!pages.has(row.sourceUrl)) pages.set(row.sourceUrl, await fetchPage(row.sourceUrl));
      const page = pages.get(row.sourceUrl);
      if (!page.ok) {
        totals.unreachable += 1;
        refused.add(`${row.sourceUrl} (${page.reason})`);
        continue;
      }
      const found = quoteOnPage(row.quote, plainText(page.text));
      if (found) totals.found += 1;
      else {
        totals.missing += 1;
        misses.push(`${data.slug}/${row.id}: ${row.sourceUrl}`);
      }
      if (write && row.quoteVerified !== found) {
        row.quoteVerified = found;
        totals.flipped += 1;
        changed = true;
      }
    }
    if (write && changed) {
      data.quotesCheckedOn = today;
      writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
      process.stdout.write(`${file}: written (quotesCheckedOn ${today})\n`);
    }
  }
  process.stdout.write(`\ncells: ${totals.found} found, ${totals.missing} missing, ${totals.unreachable} on pages that refused the fetch, ${totals.notStated} say the page does not answer\n`);
  if (misses.length) process.stdout.write(`missing:\n  ${misses.join('\n  ')}\n`);
  if (refused.size) process.stdout.write(`refused:\n  ${[...refused].join('\n  ')}\n`);
  if (write) process.stdout.write(`flipped: ${totals.flipped}\n`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
