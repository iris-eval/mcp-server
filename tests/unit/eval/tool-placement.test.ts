/*
 * Where a tool's name places it, held to labelled lists of real tool names.
 *
 * no_unusual_action counts a tool only when it is known to act. With no
 * word from the catalogue that comes down to reading a name, and a name
 * reader is a heuristic: it is only as good as the names it has met. So it
 * is measured, on lists of names each labelled by what the tool does (A it
 * acts, R it only reads, D debatable), and the floors below hold what it
 * measured:
 *
 *   tool-names.fitted.json    the list its word lists were extended on.
 *                             What it scores here is in-sample.
 *   tool-names.heldout.json   names read from published pages after the
 *                             word lists were fixed. Out-of-sample.
 *
 * Two errors, and they are not alike. An acting tool the reader does not
 * count is a departure the rule will not see (the result names the tool, so
 * a deployment can mark it in its catalogue). A look-up counted as an
 * action is a failed verdict for a run that only looked. The first is held
 * to a floor, the second to a ceiling, and the worst case of the first, an
 * acting tool read as a look-up and so not even named as unplaced, is held
 * by name.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACT_TOKENS, RUN_TOKENS, placementByName, placementOf } from '../../../src/eval/case-history.js';
import { READ_TOKENS } from '../../../src/eval/catalogue.js';

interface Listed {
  name: string;
  group: string;
  label: 'A' | 'R' | 'D';
  source?: string;
}
interface ToolNameList {
  what: string;
  provenance: string;
  names: Listed[];
}

const dir = join(__dirname, '..', '..', 'fixtures', 'case-history');
const load = (file: string): ToolNameList => JSON.parse(readFileSync(join(dir, file), 'utf-8')) as ToolNameList;

/** What the reader does with one list: how many acting tools it counts, how many look-ups it counts as actions, and which acting tools it reads as look-ups. */
function score(list: ToolNameList): { acting: number; counted: number; reading: number; falseActions: string[]; actingReadAsLookups: string[]; unplacedActing: string[] } {
  const acting = list.names.filter((n) => n.label === 'A');
  const reading = list.names.filter((n) => n.label === 'R');
  return {
    acting: acting.length,
    counted: acting.filter((n) => placementByName(n.name) === 'acts').length,
    reading: reading.length,
    falseActions: reading.filter((n) => placementByName(n.name) === 'acts').map((n) => n.name),
    actingReadAsLookups: acting.filter((n) => placementByName(n.name) === 'reads').map((n) => n.name),
    unplacedActing: acting.filter((n) => placementByName(n.name) === 'unplaced').map((n) => n.name),
  };
}

describe('the word lists', () => {
  it('no word is in two lists, and every word is one a name can split into', () => {
    for (const w of ACT_TOKENS) {
      expect(READ_TOKENS.includes(w), `${w} is a verb that acts and a verb that reads`).toBe(false);
      expect(RUN_TOKENS.has(w), `${w} is a verb that acts and a name for something that runs`).toBe(false);
    }
    for (const w of RUN_TOKENS) expect(READ_TOKENS.includes(w), w).toBe(false);
    for (const w of [...ACT_TOKENS, ...RUN_TOKENS, ...READ_TOKENS]) expect(w, w).toMatch(/^[a-z0-9]+$/);
  });
});

describe('the name reader on the list its words were extended on', () => {
  const list = load('tool-names.fitted.json');
  const s = score(list);

  it('the list is the one the floors were read on', () => {
    expect([list.names.length, s.acting, s.reading]).toEqual([230, 137, 82]);
    expect(new Set(list.names.map((n) => n.group)).size).toBe(14);
  });

  it('counts at least four in five of the acting tools, and names the rest as unplaced', () => {
    expect(s.counted).toBeGreaterThanOrEqual(FITTED.counted);
    expect(s.counted / s.acting).toBeGreaterThan(0.8);
    // An acting tool it cannot place is named in the result. One it reads as a look-up is not, so those are held by name.
    expect(s.actingReadAsLookups.sort()).toEqual(FITTED.actingReadAsLookups);
    expect(s.counted + s.unplacedActing.length + s.actingReadAsLookups.length).toBe(s.acting);
  });

  it('counts almost no look-up as an action, and those by name', () => {
    expect(s.falseActions.sort()).toEqual(FITTED.falseActions);
  });
});

describe('the name reader on a list it was not fitted on', () => {
  const list = load('tool-names.heldout.json');

  it('every name carries the page it was read from', () => {
    expect(list.names.length).toBeGreaterThan(150);
    expect(new Set(list.names.map((n) => n.group)).size).toBeGreaterThan(12);
    for (const n of list.names) expect(n.source, n.name).toMatch(/^https:\/\//);
  });

  it('counts the acting tools and spares the look-ups at the rates recorded when the list was first read', () => {
    const s = score(list);
    expect([s.acting, s.reading]).toEqual([HELDOUT.acting, HELDOUT.reading]);
    expect(s.counted).toBeGreaterThanOrEqual(HELDOUT.counted);
    expect(s.falseActions.length).toBeLessThanOrEqual(HELDOUT.falseActions);
    expect(s.actingReadAsLookups.length).toBeLessThanOrEqual(HELDOUT.actingReadAsLookups);
    // docs/api-reference.md says it in words: three in four of the acting tools, none taken for a look-up, about one look-up in thirty counted.
    expect(s.counted / s.acting).toBeGreaterThanOrEqual(0.75);
    expect(s.actingReadAsLookups).toEqual([]);
    expect(s.falseActions.length / s.reading).toBeLessThanOrEqual(1 / 30);
  });
});

describe('the catalogue places what a name cannot', () => {
  it('every acting tool the reader leaves unplaced is counted once its catalogue says it is not read-only, or that it is destructive', () => {
    const list = load('tool-names.fitted.json');
    const unplaced = score(list).unplacedActing;
    expect(unplaced.length).toBeGreaterThan(0);
    for (const name of unplaced) {
      expect(placementOf(name, [{ name, annotations: { readOnlyHint: false } }]), name).toBe('acts');
      expect(placementOf(name, [{ name, annotations: { destructiveHint: true } }]), name).toBe('acts');
      // A catalogue entry that says nothing of either leaves the name to speak, and it says nothing.
      expect(placementOf(name, [{ name, annotations: { title: name } }]), name).toBe('unplaced');
    }
  });

  it('a tool the catalogue calls read-only is a look-up whatever else it says, and whatever its name', () => {
    expect(placementOf('delete_everything', [{ name: 'delete_everything', annotations: { readOnlyHint: true, destructiveHint: true } }])).toBe('reads');
    expect(placementOf('get_report', [{ name: 'get_report', annotations: { destructiveHint: true } }])).toBe('acts');
    expect(placementOf('get_report', [{ name: 'get_report', annotations: { destructiveHint: false } }])).toBe('reads');
  });
});

/** What the reader scored on the fitted list when its word lists were fixed. A change that moves one of these is a change to what the rule counts. */
const FITTED = {
  // 114 of the 137 acting tools.
  counted: 114,
  // "select" reads a table and acts on a page; the name alone does not say which.
  actingReadAsLookups: ['browser_select_option', 'puppeteer_select'],
  // Named for a shell, with no verb to say they only look.
  falseActions: ['BashOutput', 'terminal_last_command'],
};

/** What the reader scored on the held-out list the first time it was read, with the word lists already fixed. */
const HELDOUT = {
  acting: 106,
  reading: 137,
  // 80 of the 106 acting tools; the other 26 are unplaced, and named in a result.
  counted: 80,
  // 4 of the 137 look-ups: three whose names say create or execute and whose pages say they only return something, and one whose first known verb is the "commit" in a status it checks.
  falseActions: 4,
  actingReadAsLookups: 0,
};
