/*
 * The search box refuses a too-short prefix before it sends anything
 * (#703). It must refuse exactly what the server refuses, or a user sees a
 * hint for a search the server would run, or an error for one the box let
 * through: each case below goes through the server's own parser and
 * refusal (src/storage/search.ts) and through the box's check, which must
 * agree.
 */
import { describe, expect, it } from 'vitest';
import { shortPrefixes, SEARCH_MIN_PREFIX_CHARS } from '../../../src/components/traces/TraceSearch';
import { parseSearch, searchRefusal, SEARCH_MIN_PREFIX_CHARS as SERVER_MIN } from '../../../../src/storage/search';

const CASES = [
  're*',
  'ref*',
  'refund*',
  'w* w*',
  'a*',
  '"agent sa"*',
  '"agent sai"*',
  'get_we*',
  'get_wea*',
  'é*',
  'café*',
  'caf*',
  '批*',
  '批准*',
  'ー*',
  'x1*',
  'x12*',
  'refund approved',
  '*',
  '**',
  're**',
  'ref**',
  'order 42*',
  'order 421*',
  'naïve* co*',
  'ab*cd',
  'ab*"x"',
  'ab* "x"',
  're*,',
];

describe('the search box and the server refuse the same prefixes', () => {
  it('share the minimum', () => {
    expect(SEARCH_MIN_PREFIX_CHARS).toBe(SERVER_MIN);
  });

  it.each(CASES)('%s', (q) => {
    const server = searchRefusal(parseSearch(q));
    const serverRefusesPrefix = server !== undefined && server.includes('a prefix needs');
    expect(shortPrefixes(q).length > 0).toBe(serverRefusesPrefix);
  });
});
