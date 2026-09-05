/*
 * The resources, registered the way the SDK wants them: fixed URIs with
 * registerResource, parameterised ones with a ResourceTemplate (so a
 * client's resources/templates/list shows the shape, and the SDK parses
 * the variable instead of the handler splitting a path). A resource that
 * does not exist is the protocol's resource-not-found error, never a 200
 * body with an "error" key a client would have to sniff for.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { IStorageAdapter } from '../types/query.js';
import type { Capabilities } from '../capabilities.js';
import { ruleProof } from '../capabilities.js';
import { publishedProvenance, publishedRuleNames } from '../eval/accuracy.js';
import { toEvaluationResponse } from '../eval/response.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import {
  CAPABILITIES_RESOURCE_URI,
  DASHBOARD_SUMMARY_RESOURCE_URI,
  EVALUATION_RESOURCE_TEMPLATE,
  PROOF_RESOURCE_URI,
  TRACE_RESOURCE_TEMPLATE,
} from './uris.js';

/** The MCP resource-not-found code (the spec reserves -32002 for it). */
export const RESOURCE_NOT_FOUND = -32002;

function notFound(uri: string, what: string): McpError {
  return new McpError(RESOURCE_NOT_FOUND, `Resource not found: ${uri} — no ${what} with that id is stored for this tenant`, { uri });
}

const json = (uri: string, body: unknown) => ({
  contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }],
});

export function registerAllResources(
  server: McpServer,
  storage: IStorageAdapter,
  capabilities: () => Capabilities,
): void {
  server.registerResource(
    'capabilities',
    CAPABILITIES_RESOURCE_URI,
    {
      title: 'Capabilities',
      description:
        'What this server can judge: the rule roster with what each rule needs and its published accuracy, the judge state with the steps that enable it, the citation verifier posture, the dashboard address, the limits, and the tools, resources and prompts registered.',
      mimeType: 'application/json',
    },
    async (uri) => json(uri.href, capabilities()),
  );

  server.registerResource(
    'proof',
    PROOF_RESOURCE_URI,
    {
      title: 'Proof',
      description:
        'The published accuracy of every measured built-in rule (the same numbers as https://iris-eval.com/proof): precision and recall on the proof corpus with 95% intervals, the confusion counts, positive predictive value at four prevalences, and the corpus version and labelling the numbers come from.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const prov = publishedProvenance();
      const rules: Record<string, unknown> = {};
      for (const name of publishedRuleNames()) rules[name] = ruleProof(name);
      return json(uri.href, {
        corpusVersion: prov.corpusVersion,
        release: prov.release,
        labelling: prov.labelling,
        method:
          'Each rule is run over its proof-corpus family; precision and recall carry Wilson 95% intervals; ppvAt is the positive predictive value at the stated prevalence, from the same counts. Reproduce with `npm run proof` in the repository.',
        rules,
      });
    },
  );

  server.registerResource(
    'dashboard-summary',
    DASHBOARD_SUMMARY_RESOURCE_URI,
    { title: 'Dashboard summary', description: 'Dashboard summary with key metrics and trends for the last hour', mimeType: 'application/json' },
    async (uri) => json(uri.href, await storage.getDashboardSummary(LOCAL_TENANT)),
  );

  server.registerResource(
    'trace-detail',
    new ResourceTemplate(TRACE_RESOURCE_TEMPLATE, { list: undefined }),
    { title: 'Trace', description: 'One stored trace with its spans and every evaluation linked to it', mimeType: 'application/json' },
    async (uri, variables) => {
      const traceId = String(variables.trace_id ?? '');
      const trace = await storage.getTrace(LOCAL_TENANT, traceId);
      if (!trace) throw notFound(uri.href, 'trace');
      const [spans, evals] = await Promise.all([
        storage.getSpansByTraceId(LOCAL_TENANT, traceId),
        storage.getEvalsByTraceId(LOCAL_TENANT, traceId),
      ]);
      return json(uri.href, { trace, spans, evals: evals.map((e) => toEvaluationResponse(e, { traceId })) });
    },
  );

  server.registerResource(
    'evaluation-detail',
    new ResourceTemplate(EVALUATION_RESOURCE_TEMPLATE, { list: undefined }),
    { title: 'Evaluation', description: 'One stored evaluation, in the same shape evaluate_output returned it: verdict, coverage, provenance and every rule result with its evidence', mimeType: 'application/json' },
    async (uri, variables) => {
      const id = String(variables.id ?? '');
      const result = await storage.getEvalById(LOCAL_TENANT, id);
      if (!result) throw notFound(uri.href, 'evaluation');
      return json(uri.href, toEvaluationResponse(result, { traceId: result.trace_id }));
    },
  );
}
