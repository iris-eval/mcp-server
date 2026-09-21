/*
 * POST /v1/traces — OTLP/HTTP JSON in (arc 8, R-2).
 *
 * The path is the one every OTLP exporter already posts to, so pointing a
 * collector's `otlphttp` exporter — or an SDK's `OTEL_EXPORTER_OTLP_ENDPOINT`
 * — at this server is the whole integration. Mounted on the dashboard
 * port beside the REST API, behind the same key, the same DNS-rebinding
 * guard and the same limiter; JSON only (the OTLP/HTTP protobuf encoding
 * is answered 415 naming the JSON one).
 *
 * The answer is OTLP's ExportTraceServiceResponse — `{}` when every span
 * was accepted, `partialSuccess` when some were dropped — plus an
 * `iris-eval` block an operator can read: the Iris trace id each OTLP trace became,
 * how many spans and steps it carries, what it lacked, and the evaluation
 * when `otel.evaluateOnIngest` is on and the trace carried an output.
 * Nothing here re-exports: a trace that arrived by OTLP never goes back
 * out to IRIS_OTEL_ENDPOINT, which may well be the collector that sent it.
 */
import type { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import type { EvalEngine } from '../../eval/engine.js';
import type { CustomRuleStore } from '../../custom-rule-store.js';
import type { Trace } from '../../types/trace.js';
import { requireTenant } from '../../middleware/tenant.js';
import { fromOtlp, otlpTraceRequestSchema } from '../../otel/ingest.js';
import { toSteps } from '../../eval/steps.js';
import { evaluateStoredTrace } from '../../eval/ingest.js';
import { dormantRulesFrom } from '../../eval/dormant.js';

export interface OtlpRouteOptions {
  evalEngine?: EvalEngine;
  customRuleStore?: CustomRuleStore;
  /** `otel.evaluateOnIngest` from the config: score each stored trace that carries an output. */
  evaluateOnIngest: boolean;
}

export function registerOtlpRoutes(router: Router, storage: IStorageAdapter, options: OtlpRouteOptions): void {
  router.post('/traces', async (req, res) => {
    const type = String(req.headers['content-type'] ?? '');
    if (!type.toLowerCase().includes('application/json')) {
      res.status(415).json({ error: 'This endpoint accepts OTLP/HTTP with JSON encoding (Content-Type: application/json); protobuf is not accepted. Set your exporter to the http/json protocol.' });
      return;
    }
    const parsed = otlpTraceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Not an OTLP ExportTraceServiceRequest: expected { resourceSpans: [{ resource, scopeSpans: [{ spans: [...] }] }] }',
        details: parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`),
      });
      return;
    }
    const tenantId = requireTenant(req);
    const mapped = fromOtlp(parsed.data);
    const stored: Array<Record<string, unknown>> = [];
    for (const { trace, otelTraceId, lacked } of mapped.traces) {
      await storage.insertTrace(tenantId, trace);
      const entry: Record<string, unknown> = {
        trace_id: trace.trace_id,
        otel_trace_id: otelTraceId,
        agent_name: trace.agent_name,
        spans: trace.spans?.length ?? 0,
        steps: toSteps({ spans: trace.spans }).length,
        lacked,
      };
      if (options.evaluateOnIngest && options.evalEngine && trace.output !== undefined) {
        const { response } = await evaluateStoredTrace(options.evalEngine, storage, tenantId, trace as Trace & { output: string }, {
          dormant: options.customRuleStore ? dormantRulesFrom(options.customRuleStore.quarantined(tenantId)) : undefined,
        });
        entry.evaluation = response;
      } else if (options.evaluateOnIngest && trace.output === undefined) {
        entry.evaluation = null;
      }
      stored.push(entry);
    }
    const body: Record<string, unknown> = {};
    if (mapped.rejectedSpans > 0) {
      body.partialSuccess = { rejectedSpans: mapped.rejectedSpans, errorMessage: mapped.rejections.join(' | ') };
    }
    body['iris-eval'] = { stored, count: stored.length, evaluate_on_ingest: options.evaluateOnIngest };
    res.status(200).json(body);
  });
}
