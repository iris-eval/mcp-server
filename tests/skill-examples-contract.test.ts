/*
 * The skill's worked examples and its tools table, held to the server.
 *
 * skills/iris-eval/examples/ teaches Iris through requests and the answers
 * to them. The answers were captured by hand once, the verdict was rebuilt
 * after, and by 0.21.0 two of the three pages showed `passed: false` for a
 * request the server answers `passed: true` (#1021). SKILL.md's tools table
 * was written by hand under a count that is rendered, and listed nine of
 * the twelve tools.
 *
 * Every request and response on those pages is now written by
 * scripts/claims/render-skill-examples.ts, which makes the call against the
 * real server. This test makes the calls again and compares: a change to
 * the engine that moves an answer fails here until the pages are rendered
 * and read again, and one that makes a sentence of a page untrue fails with
 * the sentence.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EXAMPLES, renderSkillExamples, textBlock } from '../scripts/claims/render-skill-examples.js';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf-8').replace(/\r\n/g, '\n');

describe('the skill\'s examples are the server\'s answers', () => {
  it('each page holds the requests as sent and the responses as they came back, and every sentence a page relies on holds', async () => {
    const rendered = await renderSkillExamples(root);
    expect(rendered.map((r) => r.output)).toEqual(EXAMPLES.map((e) => e.file));
    for (const page of rendered) {
      expect(page.text.replace(/\r\n/g, '\n'), `${page.output}: run \`npm run skill-examples:render\`, read the page against its new blocks, and commit`).toBe(read(page.output));
    }
  }, 120_000);

  it('every JSON block on a page parses', () => {
    for (const example of EXAMPLES) {
      const text = read(example.file);
      const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
      expect(blocks.length, example.file).toBeGreaterThan(0);
      for (const block of blocks) expect(() => JSON.parse(block), `${example.file}: ${block.slice(0, 80)}`).not.toThrow();
    }
  });

  it('each scenario block holds what the page\'s calls send: the ask, the outputs, the run', () => {
    for (const example of EXAMPLES) {
      const text = read(example.file);
      expect(example.texts.length, example.file).toBeGreaterThan(0);
      for (const t of example.texts) {
        const start = `<!-- iris:${t.block}:start -->\n`;
        const from = text.indexOf(start);
        const to = text.indexOf(`\n<!-- iris:${t.block}:end -->`);
        expect(from, `${example.file}: ${t.block}`).toBeGreaterThan(-1);
        expect(text.slice(from + start.length, to), `${example.file}: ${t.block}`).toBe(textBlock(t.text));
      }
    }
  });

  it('rendering leaves the caller\'s Iris home as it found it: one that is not there is not made', async () => {
    const absent = join(tmpdir(), `iris-skill-examples-caller-${process.pid}-${Date.now()}`);
    const saved = process.env.IRIS_HOME;
    const savedDbPath = process.env.IRIS_DB_PATH;
    process.env.IRIS_HOME = absent;
    // The configuration takes its default store path from the home when it is first imported: import it again, here.
    vi.resetModules();
    try {
      const fresh = (await import('../scripts/claims/render-skill-examples.js')) as typeof import('../scripts/claims/render-skill-examples.js');
      await fresh.renderSkillExamples(root);
      expect(existsSync(absent)).toBe(false);
      // And the environment is put back as it was.
      expect(process.env.IRIS_HOME).toBe(absent);
      expect(process.env.IRIS_DB_PATH).toBe(savedDbPath);
    } finally {
      if (saved === undefined) delete process.env.IRIS_HOME;
      else process.env.IRIS_HOME = saved;
      rmSync(absent, { recursive: true, force: true });
      vi.resetModules();
    }
  }, 120_000);

  it('every call a page lists has its blocks in the page, and no block is left without a call', () => {
    for (const example of EXAMPLES) {
      const text = read(example.file);
      const expected = new Set<string>(example.texts.map((t) => t.block));
      for (const deployment of example.deployments) {
        if (deployment.config !== undefined) expected.add(deployment.config.block);
        for (const call of deployment.calls) for (const kind of call.blocks) expected.add(`${call.name}-${kind}`);
      }
      const present = new Set([...text.matchAll(/<!-- iris:([a-z0-9-]+):start -->/g)].map((m) => m[1]));
      expect([...present].sort(), example.file).toEqual([...expected].sort());
    }
  });

  it('no page says its results were captured on a day', () => {
    for (const example of EXAMPLES) expect(read(example.file), example.file).not.toMatch(/captured \d{4}-\d{2}-\d{2}/);
  });
});

describe('the skill\'s tools table', () => {
  const claims = JSON.parse(read('.claims.json')) as { mcpTools: { names: string[]; count: number } };

  it('is rendered from the manifest, not written by hand', () => {
    const template = read('skills/iris-eval/SKILL.template.md');
    const from = template.indexOf('\n## The {{mcpToolCount}} tools');
    const section = template.slice(from, template.indexOf('\n## ', from + 1));
    expect(section).toContain('{{mcpToolsTable}}');
    expect(section).not.toMatch(/^\| `[a-z_]+` \|/m);
  });

  it('names every tool the server registers, and no other, in each page rendered from it', () => {
    for (const file of ['skills/iris-eval/SKILL.md', 'claude-plugin/skills/iris-eval/SKILL.md']) {
      const text = read(file);
      const from = text.indexOf('\n## The ');
      const to = text.indexOf('\n## ', from + 1);
      expect(from, `${file}: the tools section`).toBeGreaterThan(-1);
      const section = text.slice(from, to === -1 ? undefined : to);
      const named = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
      expect([...named].sort(), file).toEqual([...claims.mcpTools.names].sort());
      expect(named.length, file).toBe(claims.mcpTools.count);
    }
  });
});
