import { Router } from 'express';
import { toEvaluationResponse } from '../../eval/response.js';
import type { IStorageAdapter } from '../../types/query.js';
import type { Trace } from '../../types/trace.js';
import type { EvalEngine } from '../../eval/engine.js';
import { requireTenant } from '../../middleware/tenant.js';
import { generateTraceId, generateSpanId } from '../../utils/ids.js';
import { bestEffortExport } from '../../otel/lazy.js';
import { traceQuerySchema, ingestTraceSchema } from '../validation.js';
import { DEFAULT_EVAL_TYPE, DEFAULT_EVAL_TYPE_NOTE } from '../../eval/engine.js';

export interface TraceRouteOptions {
  /**
   * Live engine for the `evaluate: true` opt-in on POST /traces. When
   * absent (an embedder that wired storage but no engine), an evaluate
   * request is refused with 501 BEFORE the trace is stored — silently
   * storing without the requested eval would be a skipped gate dressed
   * as a success.
   */
  evalEngine?: EvalEngine;
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
          error: 'Evaluation is not available on this server — trace was NOT stored. Retry without "evaluate", or start the dashboard via iris-mcp so the eval engine is wired.',
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

      // Deterministic engine, same context evaluate_output builds. The
      // superRefine on ingestTraceSchema guarantees output is present.
      // eval_type="all" takes the same every-bundle path the MCP tool
      // takes (evaluateAll): one pass, one regex budget, the critical veto
      // spanning every bundle, and a per-category breakdown — stored under
      // eval_type "all" so the dashboard reads it as the tool's rows.
      const context = {
        output: body.output as string,
        input: body.input,
        costUsd: body.cost_usd,
        tokenUsage: body.token_usage,
        // The trajectory the SAME request just stored. This body already
        // carries what the agent did; not forwarding it made every
        // trajectory rule skip on the one path where the data was
        // guaranteed present — an ingest that captured a failed tool call
        // and then evaluated as though it had never been told.
        toolCalls: body.tool_calls,
      };
      // An omitted eval_type runs every bundle — the same default, from the
      // same constant, as the MCP tool — and says so in the response.
      const evalTypeOmitted = body.eval_type === undefined;
      const evalType = body.eval_type ?? DEFAULT_EVAL_TYPE;
      const evaluation =
        evalType === 'all'
          ? options.evalEngine.evaluateAll(context)
          : options.evalEngine.evaluate(evalType, context);
      evaluation.trace_id = traceId;
      await storage.insertEvalResult(tenantId, evaluation);

      // The same serializer as evaluate_output (src/eval/response.ts): the
      // veto reason, the skipped criticals, the verdict basis, coverage and
      // provenance travel the ingest path exactly as they travel the tool.
      res.status(201).json({
        trace_id: traceId,
        status: 'stored',
        evaluation: toEvaluationResponse(evaluation, { traceId, ...(evalTypeOmitted ? { note: DEFAULT_EVAL_TYPE_NOTE } : {}) }),
      });
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
