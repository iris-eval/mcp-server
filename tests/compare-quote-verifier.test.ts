/*
 * The compare-quote verifier reads a page the way a reader would (arc 9, N-21).
 *
 * scripts/verify-compare-quotes.mjs decides `quoteVerified` for every compare
 * cell: is the cell's sentence on a plain download of its page today. The
 * reading is the whole method, so it is held here on synthetic pages: a tag
 * boundary that leaves a space before a comma, a table cell whose text
 * starts with "<", a page that answers a plain fetch with Markdown (links,
 * backticks, bold, heading marks), curly quotes and dashes — all fold to the
 * words; a quote the page does not carry, including one that ends a sentence
 * the page continues, stays unverified. Loosen the reading and a cell can be
 * marked found on a page that does not say it.
 */
import { describe, expect, it } from 'vitest';
import { fold, plainText, quoteOnPage } from '../scripts/verify-compare-quotes.mjs';

const HTML =
  '<!doctype html><html><head><title>t</title><style>.x{color:red}</style><script>var a = "<b>";</script></head><body>' +
  '<table><tr><td>P95 Latency</td><td><5ms</td><td>~60-100ms</td></tr></table>' +
  '<p>so we built native SDKs for <a href="/j">Java</a>, <a href="/g">Go</a> , <em>Ruby</em>, and C#.</p>' +
  '<p>Metrics<!-- c --> : Latency, token counts, costs</p>' +
  '<p>It&#39;s &ldquo;quoted&rdquo; &amp; &#x27;marked&#x27; &#8211; dashed</p>' +
  '</body></html>';

const MARKDOWN =
  '## Core ($29/month) For production projects\n\n' +
  'As the Langfuse SDKs are [asynchronous](/docs/data-model#background), they buffer [observations](/docs/observations) in the background.\n' +
  '`deepeval` offers 50+ SOTA, ready-to-use metrics for you to quickly get started with.\n' +
  'The **Judgment MCP server** gives coding agents tools. See _Features_ and run_experiment.\n' +
  'Weave comes with predefined scorers that you can use right away, including:\n';

describe('the verifier reads a page as its words', () => {
  it('strips tags, scripts, styles and comments, decodes entities, and keeps a "<" that starts a table cell', () => {
    const text = plainText(HTML);
    expect(text).not.toMatch(/<\/?(td|tr|table|p|a|em|html|body)\b/);
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('var a');
    expect(text).toContain('P95 Latency <5ms ~60-100ms');
    expect(text).toContain('It\'s "quoted" & \'marked\'');
  });

  it('a script or style block ends at a closing tag with space inside it too, and an escaped entity is decoded once, never twice', () => {
    expect(plainText('<p>a</p><script >var x = 1;</script ><style type="text/css" >p{}</style >b')).toBe('a b');
    expect(plainText('&amp;lt;b&amp;gt; and &amp;amp;')).toBe('&lt;b&gt; and &amp;');
    expect(plainText('&lt;b&gt;')).toBe('<b>');
  });

  it('folds the space a stripped tag leaves before punctuation on both sides, so a link boundary never decides', () => {
    const page = plainText(HTML);
    expect(quoteOnPage('built native SDKs for Java, Go, Ruby, and C#', page)).toBe(true);
    expect(quoteOnPage('Metrics: Latency, token counts, costs', page)).toBe(true);
    expect(fold('Java , Go , Ruby')).toBe('Java, Go, Ruby');
    expect(fold('( web , api )')).toBe('(web, api)');
  });

  it('reads a page served as Markdown by its words: link text, no backticks, no bold, no heading marks, emphasis kept inside identifiers', () => {
    const page = plainText(MARKDOWN);
    expect(quoteOnPage('Core ($29/month) For production projects', page)).toBe(true);
    expect(quoteOnPage('As the Langfuse SDKs are asynchronous, they buffer observations in the background.', page)).toBe(true);
    expect(quoteOnPage('deepeval offers 50+ SOTA, ready-to-use metrics', page)).toBe(true);
    expect(quoteOnPage('The Judgment MCP server gives coding agents tools.', page)).toBe(true);
    expect(quoteOnPage('See Features and run_experiment.', page)).toBe(true);
    expect(page).toContain('run_experiment');
  });

  it('folds typography — curly quotes and en/em dashes — on both sides', () => {
    expect(quoteOnPage("It's \"quoted\" & 'marked' - dashed", plainText(HTML))).toBe(true);
    expect(fold('a — b – c ’d’')).toBe("a - b - c 'd'");
  });

  it('a sentence the page continues is not on the page with its full stop; a quote the page lacks stays unverified; an empty quote is never found', () => {
    const page = plainText(MARKDOWN);
    expect(quoteOnPage('that you can use right away.', page)).toBe(false);
    expect(quoteOnPage('that you can use right away', page)).toBe(true);
    expect(quoteOnPage('Self-hosting is only available on the Enterprise plan.', page)).toBe(false);
    expect(quoteOnPage('', page)).toBe(false);
    expect(quoteOnPage('   ', page)).toBe(false);
  });
});
