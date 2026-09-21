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
import { traceContextFrom, withTraceContext } from '../../otel/trace-context.js';
import type { IStorageAdapter } from '../../types/query.js';
import type { EvalEngine } from '../../eval/engine.js';
import type { CustomRuleStore } from '../../custom-rule-store.js';
import type { Trace } from '../../types/trace.js';
import { requireTenant } from '../../middleware/tenant.js';
import { fromOtlp, otlpTraceRequestSchema } from '../../otel/ingest.js';
import { decodeExportTraceServiceRequest, OtlpProtobufError } from '../../otel/protobuf.js';
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
    /*
     * Two encodings, one path (arc 9, N-10). JSON is parsed by the app's
     * body parser; protobuf arrives as raw bytes and is decoded into the
     * same OTLP/JSON object here, so the schema, the mapping and every
     * test below this line are the JSON path. The Python exporter sends
     * protobuf only, so until 0.16.0 no Python framework reached this door
     * without a Collector between.
     */
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    let payload: unknown;
    if (type.includes('application/x-protobuf')) {
      /*
       * express.raw hands the decoder a Buffer; anything else here is a
       * request with no body (the parser did not run) or a tampered one,
       * and is refused as such rather than decoded as an empty message.
       * The typeof / Array.isArray checks are the type-tampering guard
       * CodeQL reads (js/type-confusion-through-parameter-tampering).
       */
      const body: unknown = req.body;
      if (typeof body === 'string' || Array.isArray(body) || !Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'An application/x-protobuf request must carry the bytes of an ExportTraceServiceRequest; the body was empty or not bytes' });
        return;
      }
      try {
        payload = decodeExportTraceServiceRequest(body);
      } catch (err) {
        const message = err instanceof OtlpProtobufError ? err.message : err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: `Not a protobuf ExportTraceServiceRequest: ${message}` });
        return;
      }
    } else if (type.includes('application/json')) {
      payload = req.body;
    } else {
      res.status(415).json({ error: 'This endpoint accepts OTLP/HTTP as JSON (Content-Type: application/json) or protobuf (Content-Type: application/x-protobuf). gRPC is not served: point a Collector\'s otlphttp exporter here.' });
      return;
    }
    const parsed = otlpTraceRequestSchema.safeParse(payload);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Not an OTLP ExportTraceServiceRequest: expected { resourceSpans: [{ resource, scopeSpans: [{ spans: [...] }] }] }',
        details: parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`),
      });
      return;
    }
    const tenantId = requireTenant(req);
    const mapped = fromOtlp(parsed.data);
    // The W3C context on the request, if a proxy or a client set one (SEP-414 names the header; arc 9, N-12).
    const headerContext = traceContextFrom(req.headers as Record<string, unknown>);
    const stored: Array<Record<string, unknown>> = [];
    for (const { trace, otelTraceId, lacked } of mapped.traces) {
      if (headerContext) trace.metadata = withTraceContext(trace.metadata, headerContext);
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
