// OTLP/HTTP JSON exporter — posts ExportTraceServiceRequest payloads to
// an OpenTelemetry collector, Jaeger, Grafana Tempo, or Datadog OTLP
// ingest endpoint. Works against any receiver that speaks OTLP/HTTP
// JSON at /v1/traces (the OTLP spec canonical path).
//
// Hand-rolled against the OTLP spec rather than pulling in @opentelemetry/*
// — consistent with the LLM client + citation resolver approach (keep
// supply-chain surface small, the wire format is simple). gRPC transport
// is not included in v0.4.0; callers with gRPC-only receivers should
// front it with an HTTP-accepting collector (Jaeger/Tempo/OTEL Collector
// accept HTTP natively).
//
// Batch behavior: callers (typically log_trace handler) accumulate Trace
// rows and call exportTraces([...]) at convenient points. The exporter
// does NOT own a timer — keeping it stateless keeps it testable and
// avoids accidentally leaking a process-wide interval in tests.

import { buildExportPayload } from './mapper.js';
import type { Trace } from '../types/trace.js';

export interface OtelExporterConfig {
  endpoint: string;                           // e.g. https://otel.company.com:4318
  serviceName: string;                        // e.g. iris-mcp
  headers?: Record<string, string>;           // e.g. { authorization: 'Bearer ...' }
  timeoutMs?: number;
  pathPrefix?: string;                        // default '/v1/traces' per OTLP spec
}

export interface OtelExportResult {
  ok: boolean;
  status: number;
  bytesSent: number;
  latencyMs: number;
  error?: string;
}

export class OtelExporter {
  private readonly endpoint: string;
  private readonly serviceName: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: OtelExporterConfig) {
    // Normalize endpoint — strip trailing slash; append /v1/traces if
    // the caller gave a collector root. This matches the behavior of
    // the official OTLP/HTTP clients.
    const base = config.endpoint.replace(/\/+$/, '');
    const path = config.pathPrefix ?? '/v1/traces';
    this.endpoint = base.endsWith(path) ? base : base + path;
    this.serviceName = config.serviceName;
    this.headers = { ...(config.headers ?? {}) };
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  async exportTraces(traces: readonly Trace[]): Promise<OtelExportResult> {
    if (traces.length === 0) {
      return { ok: true, status: 204, bytesSent: 0, latencyMs: 0 };
    }

    const payload = buildExportPayload(traces, this.serviceName);
    const body = JSON.stringify(payload);

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...this.headers,
        },
        body,
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          ok: false,
          status: res.status,
          bytesSent: body.length,
          latencyMs,
          error: `OTLP exporter got ${res.status}: ${text.slice(0, 200)}`,
        };
      }
      return {
        ok: true,
        status: res.status,
        bytesSent: body.length,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 0,
        bytesSent: body.length,
        latencyMs,
        error: msg,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function exporterFromEnv(): OtelExporter | null {
  const endpoint = process.env.IRIS_OTEL_ENDPOINT;
  if (!endpoint) return null;

  const serviceName = process.env.IRIS_OTEL_SERVICE_NAME ?? 'iris-mcp';

  // IRIS_OTEL_HEADERS is a comma-separated list of key=value pairs —
  // the OTel Collector convention. e.g. "authorization=Bearer xyz,x-tenant=foo".
  let headers: Record<string, string> | undefined;
  const rawHeaders = process.env.IRIS_OTEL_HEADERS;
  if (rawHeaders) {
    headers = {};
    for (const pair of rawHeaders.split(',')) {
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (k && v) headers[k] = v;
    }
  }

  const timeoutRaw = process.env.IRIS_OTEL_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;

  return new OtelExporter({
    endpoint,
    serviceName,
    headers,
    timeoutMs: Number.isFinite(timeoutMs) && (timeoutMs as number) > 0 ? (timeoutMs as number) : undefined,
  });
}
