/*
 * The discovery manifest equals the built server (A6-8).
 *
 * website/public/.well-known/mcp.json was hand-maintained: on 2026-09-07 it
 * carried tool descriptions written apart from the ones the server sends,
 * one resource of five, no prompt and one install block. The version was
 * synced and the tool NAMES were tested; everything else drifted, because
 * nothing read the file against the server.
 *
 * What this file checks, precisely: the committed manifest is byte-equal
 * (modulo line endings) to what scripts/claims/render-mcp-json.ts renders
 * from the server booted in-process; every tool, resource, template and
 * prompt the manifest lists is registered, and every registered one is
 * listed; the version is package.json's; every install block is keyed by
 * the one public identifier; each tool description is one paragraph.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { renderManifest, serialize, firstParagraph, MANIFEST_PATH, type Manifest } from '../scripts/claims/render-mcp-json.js';
import { TOOL_NAMES } from '../src/tools/index.js';
import { RESOURCE_URIS, FIXED_RESOURCE_URIS, RESOURCE_TEMPLATES } from '../src/resources/uris.js';
import { EVALUATE_MY_AGENT_PROMPT } from '../src/instructions.js';
import { PUBLIC_ID } from '../src/identity.js';

const root = resolve(__dirname, '..');
const committedText = readFileSync(join(root, MANIFEST_PATH), 'utf-8');
const committed = JSON.parse(committedText) as Manifest;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version: string };

let rendered: Manifest;
beforeAll(async () => {
  rendered = await renderManifest();
});

describe('.well-known/mcp.json — rendered from the built server', () => {
  it('the committed file equals the render (run npm run mcp-json:render after any tool, resource or prompt change)', () => {
    expect(committedText.replace(/\r\n/g, '\n')).toBe(serialize(rendered));
  });

  it('lists every registered tool, no more, no fewer, each with its one-paragraph summary', () => {
    expect(committed.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of committed.tools) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.description, t.name).not.toContain('\n');
      expect(t.description, `${t.name} carries a heading, not a summary`).not.toMatch(/What it does\.|Returns\.|Siblings\./);
    }
  });

  it('lists every resource and every template, and nothing unregistered', () => {
    expect(committed.resources.map((r) => r.uri).sort()).toEqual([...RESOURCE_URIS].sort());
    for (const r of committed.resources) {
      expect(r.description.length, r.uri).toBeGreaterThan(10);
      const isTemplate = (RESOURCE_TEMPLATES as readonly string[]).includes(r.uri);
      expect(r.template === true, r.uri).toBe(isTemplate);
      if (!isTemplate) expect(FIXED_RESOURCE_URIS as readonly string[]).toContain(r.uri);
    }
  });

  it('lists the one prompt', () => {
    expect(committed.prompts.map((p) => p.name)).toEqual([EVALUATE_MY_AGENT_PROMPT]);
  });

  it('carries the package version and the one public identifier on every install block', () => {
    expect(committed.version).toBe(pkg.version);
    expect(committed.id).toBe(PUBLIC_ID);
    expect(Object.keys(committed.install.claude_desktop.mcpServers)).toEqual([PUBLIC_ID]);
    expect(Object.keys(committed.install.cursor.mcpServers)).toEqual([PUBLIC_ID]);
    expect(committed.install.claude_code.command).toContain(`claude mcp add ${PUBLIC_ID} `);
    expect(committed.install.docker.command).toMatch(/-e IRIS_API_KEY=/);
    expect(JSON.stringify(committed)).not.toMatch(/"iris"\s*:/);
    expect(JSON.stringify(committed)).not.toContain('iris-mcp');
  });

  it('firstParagraph takes the summary sentence and nothing after the first blank line', () => {
    expect(firstParagraph('One sentence.\n\nWhat it does. More.')).toBe('One sentence.');
    expect(firstParagraph(undefined)).toBe('');
  });
});
