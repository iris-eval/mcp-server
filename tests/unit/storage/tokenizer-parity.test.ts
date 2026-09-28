/*
 * The search tokenizer is SQLite's (#682).
 *
 * src/storage/search.ts splits a query, the text the search without FTS5
 * reads and the text a snippet marks with a table generated from SQLite's
 * `unicode61 remove_diacritics 2` (unicode61.generated.ts; CI regenerates
 * it). This checks the algorithm around the table: seeded random strings
 * drawn from every plane — ASCII, Latin with accents and combining marks,
 * Greek, Cyrillic, Hangul, kana, Han, emoji, private use, lone marks,
 * separators — must come out as exactly the words FTS5 stores, in order.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { parseSearch, tokenize } from '../../../src/storage/search.js';
import { fnv1a, mulberry32 } from '../../../src/eval/stats.js';

const POOLS: Array<[number, number]> = [
  [0x20, 0x7e],
  [0xc0, 0x24f],
  [0x300, 0x36f],
  [0x370, 0x3ff],
  [0x400, 0x4ff],
  [0x1100, 0x11ff],
  [0x3000, 0x30ff],
  [0x4e00, 0x4fff],
  [0xac00, 0xad00],
  [0xff00, 0xffef],
  [0xe000, 0xe0ff],
  [0x1f300, 0x1f6ff],
  [0x20000, 0x200ff],
  [0x2000, 0x206f],
];

function randomText(rng: () => number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i += 1) {
    const [a, b] = POOLS[Math.floor(rng() * POOLS.length)];
    s += String.fromCodePoint(a + Math.floor(rng() * (b - a + 1)));
  }
  return s;
}

describe('the search tokenizer is SQLite’s unicode61', () => {
  it('splits and folds 2,000 random strings from every plane exactly as FTS5 does', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'unicode61 remove_diacritics 2'); CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');`);
    const rng = mulberry32(fnv1a('tokenizer-parity'));
    const texts = Array.from({ length: 2_000 }, () => randomText(rng, 1 + Math.floor(rng() * 40)));
    const insert = db.prepare('INSERT INTO t (rowid, x) VALUES (?, ?)');
    db.transaction(() => texts.forEach((text, i) => insert.run(i + 1, text)))();
    const byDoc = new Map<number, string[]>();
    for (const row of db.prepare('SELECT doc, term FROM v ORDER BY doc, offset').all() as Array<{ doc: number; term: string }>) {
      byDoc.set(row.doc, [...(byDoc.get(row.doc) ?? []), row.term]);
    }
    const differ = texts.filter((text, i) => JSON.stringify(tokenize(text).map((t) => t.norm)) !== JSON.stringify(byDoc.get(i + 1) ?? []));
    expect(differ).toEqual([]);
    db.close();
  });

  it('finds a Korean word with the index: the query is split the way the index stored it', () => {
    expect(parseSearch('승인').terms[0].tokens).toEqual(['승인']);
    expect(parseSearch('Ａｐｐｌｅ').terms[0].tokens).toEqual(['ａｐｐｌｅ']);
    expect(parseSearch('Café').terms[0].tokens).toEqual(['cafe']);
  });
});
