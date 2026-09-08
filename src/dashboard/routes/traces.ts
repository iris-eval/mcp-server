import { Router } from 'express';
import { evaluateStoredTrace } from '../../eval/ingest.js';
import { dormantRulesFrom } from '../../eval/dormant.js';
import type { CustomRuleStore } from '../../custom-rule-store.js';
import type { IStorageAdapter } from '../../types/query.js';
import type { Trace } from '../../types/trace.js';
import type { EvalEngine } from '../../eval/engine.js';
import { requireTenant } from '../../middleware/tenant.js';
import { generateTraceId, generateSpanId } from '../../utils/ids.js';
import { bestEffortExport } from '../../otel/lazy.js';
import { traceQuerySchema, ingestTraceSchema } from '../validation.js';

export interface TraceRouteOptions {
  /**
   * Live engine for the `evaluate: true` opt-in on POST /traces. When
   * absent (an embedder that wired storage but no engine), an evaluate
   * request is refused with 501 BEFORE the trace is stored — silently
   * storing without the requested eval would be a skipped gate dressed
   * as a success.
   */
  evalEngine?: EvalEngine;
  /** The custom-rule store, so an evaluation over HTTP carries coverage.dormant like the tool does. */
  customRuleStore?: CustomRuleStore;
}

export function registerTraceRoutes(
  router: Router,
  storage: IStorageAdapter,
  options?: TraceRouteOptions,
): void {
  /*
   * Deterministic capture over HTTP. MCP tool calls are model-
   * discretionary — a trace lands only if the model chooses to call
   * log_trace — so builders get a path that doesn't depend on the model:
   * POST the same body the log_trace tool accepts (ingestTraceSchema IS
   * that schema) and the row is stored unconditionally. Sits behind the
   * full middleware stack: loopback bind + DNS-rebinding guard + auth +
   * tenant resolution + the shared API rate limiter.
   */
  router.post('/traces', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const body = ingestTraceSchema.parse(req.body);

      if (body.evaluate && !options?.evalEngine) {
        res.status(501).json({
          error: 'Evaluation is not available on this server — trace was NOT stored. Retry without "evaluate", or start the dashboard via iris-eval so the eval engine is wired.',
        });
        return;
      }

      // Server-minted, exactly like log_trace — a client-supplied
      // trace_id was already REJECTED by the strict schema above (400,
      // with a message saying the server mints it).
      const traceId = generateTraceId();
      const timestamp = body.timestamp ?? new Date().toISOString();

      const trace: Trace = {
        trace_id: traceId,
        agent_name: body.agent_name,
        framework: body.framework,
        input: body.input,
        output: body.output,
        tool_calls: body.tool_calls,
        latency_ms: body.latency_ms,
        token_usage: body.token_usage,
        cost_usd: body.cost_usd,
        metadata: body.metadata as Record<string, unknown> | undefined,
        timestamp,
        tools: body.tools,
        run_id: body.run,
        case_key: body.case_key,
        source: 'http',
        spans: body.spans?.map((s) => ({
          ...s,
          span_id: s.span_id ?? generateSpanId(),
          trace_id: traceId,
        })),
      };

      await storage.insertTrace(tenantId, trace);

      // Same best-effort OTel fan-out as log_trace: switching capture
      // paths must not silently drop the operator's collector feed.
      bestEffortExport(trace, (err) => {
        // eslint-disable-next-line no-console
        console.warn(`[iris.otel] ${err.message}`);
      });

      if (!body.evaluate || !options?.evalEngine) {
        res.status(201).json({ trace_id: traceId, status: 'stored' });
        return;
      }

      // One store-and-evaluate primitive (src/eval/ingest.ts), shared with
      // the log_trace tool's evaluate: true and the CLI: the same context,
      // the same bundle default, the same serializer. The superRefine on
      // ingestTraceSchema guarantees output is present.
      const { response } = await evaluateStoredTrace(options.evalEngine, storage, tenantId, trace as Trace & { output: string }, {
        evalType: body.eval_type,
        dormant: options?.customRuleStore ? dormantRulesFrom(options.customRuleStore.quarantined(tenantId)) : undefined,
      });
      res.status(201).json({ trace_id: traceId, status: 'stored', evaluation: response });
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid trace payload', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  router.get('/traces', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const query = traceQuerySchema.parse(req.query);
      const result = await storage.queryTraces(tenantId, {
        filter: {
          agent_name: query.agent_name,
          framework: query.framework,
          since: query.since,
          until: query.until,
          min_score: query.min_score,
          max_score: query.max_score,
        },
        limit: query.limit,
        offset: query.offset,
        sort_by: query.sort_by,
        sort_order: query.sort_order,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  router.get('/traces/:id', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const trace = await storage.getTrace(tenantId, req.params.id);
      if (!trace) {
        res.status(404).json({ error: 'Trace not found' });
        return;
      }
      const spans = await storage.getSpansByTraceId(tenantId, req.params.id);
      const evals = await storage.getEvalsByTraceId(tenantId, req.params.id);
      res.json({ trace, spans, evals });
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });
}
