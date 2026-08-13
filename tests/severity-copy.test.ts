/**
 * Severity copy drift lock — the dashboard badge and the MCP tool must say
 * the same thing about what severity DOES.
 *
 * v0.5.0 turned `high`/`critical` from a triage label into a hard veto: a
 * failing high/critical rule forces `passed: false` regardless of the
 * weighted score. `deploy_rule`'s description was updated; the dashboard's
 * severity tooltips were not, and kept telling users "failures should be
 * reviewed within the day" / "should page" on the badge of a rule that now
 * blocks every evaluation it loses. Authoritative help text describing the
 * opposite of the shipped behaviour is worse than no help text.
 *
 * So the two surfaces now share one pair of phrases, and this test fails if
 * either side edits them independently.
 */
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SEVERITY_HARD_FAIL,
  SEVERITY_WEIGHT_ONLY,
  TT,
} from '../dashboard/src/components/shared/tooltipText.js';
import { registerDeployRuleTool } from '../src/tools/deploy-rule.js';
import type { CustomRuleStore } from '../src/custom-rule-store.js';
import type { EvalEngine } from '../src/eval/engine.js';

/*
 * Captures the severity field's `.describe()` text as the SDK receives it.
 * `inputSchema` is a strictObject (see strict-input.ts), so the per-field
 * description lives on `.shape.severity`, not on the top-level object.
 */
function severityDescription(): string {
  let captured: string | undefined;
  const server = {
    registerTool(name: string, config: { inputSchema?: unknown }) {
      if (name !== 'deploy_rule') return;
      const schema = config.inputSchema as
        | { shape?: Record<string, { description?: string }> }
        | undefined;
      captured = schema?.shape?.severity?.description;
    },
  } as unknown as McpServer;

  registerDeployRuleTool(server, {} as CustomRuleStore, {} as EvalEngine);
  expect(captured, 'deploy_rule severity field lost its description').toBeTruthy();
  return captured!;
}

describe('severity copy stays in lockstep', () => {
  it('deploy_rule states the weight-only semantics verbatim', () => {
    expect(severityDescription()).toContain(SEVERITY_WEIGHT_ONLY);
  });

  it('deploy_rule states the hard-fail semantics verbatim', () => {
    expect(severityDescription()).toContain(SEVERITY_HARD_FAIL);
  });

  it('every severity tooltip carries the matching phrase', () => {
    expect(TT.ruleSeverityLow).toContain(SEVERITY_WEIGHT_ONLY);
    expect(TT.ruleSeverityMedium).toContain(SEVERITY_WEIGHT_ONLY);
    expect(TT.ruleSeverityHigh).toContain(SEVERITY_HARD_FAIL);
    expect(TT.ruleSeverityCritical).toContain(SEVERITY_HARD_FAIL);
  });

  it('no severity tooltip describes severity as a paging/triage concept', () => {
    for (const copy of [
      TT.ruleSeverityLow,
      TT.ruleSeverityMedium,
      TT.ruleSeverityHigh,
      TT.ruleSeverityCritical,
    ]) {
      expect(copy).not.toMatch(/should page|reviewed within the day|not urgent/i);
    }
  });

  it('high and critical name critical_failures so the UI can point at the culprit', () => {
    expect(TT.ruleSeverityHigh).toContain('critical_failures');
    expect(TT.ruleSeverityCritical).toContain('critical_failures');
  });
});
