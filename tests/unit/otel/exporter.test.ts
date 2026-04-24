import { describe, it, expect, vi, afterEach } from 'vitest';
import { OtelExporter, exporterFromEnv } from '../../../src/otel/exporter.js';
import type { Trace } from '../../../src/types/trace.js';

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

const trace: Trace = {
  trace_id: '00000000000000000000000000000001',
  agent_name: 'test',
  timestamp: '2026-04-24T12:00:00Z',
};

describe('OtelExporter', () => {
  it('appends /v1/traces when the caller gives a collector root', () => {
    const exporter = new OtelExporter({
      endpoint: 'https://otel.example.com:4318',
      serviceName: 'iris',
    });
    // @ts-expect-error — reading private for test; endpoint normalization is the contract.
    expect(exporter.endpoint).toBe('https://otel.example.com:4318/v1/traces');
  });

  it('does not double-append if caller already included /v1/traces', () => {
    const exporter = new OtelExporter({
      endpoint: 'https://otel.example.com:4318/v1/traces',
      serviceName: 'iris',
    });
    // @ts-expect-error — reading private for test
    expect(exporter.endpoint).toBe('https://otel.example.com:4318/v1/traces');
  });

  it('strips trailing slash before appending path', () => {
    const exporter = new OtelExporter({
      endpoint: 'https://otel.example.com:4318/',
      serviceName: 'iris',
    });
    // @ts-expect-error — reading private for test
    expect(exporter.endpoint).toBe('https://otel.example.com:4318/v1/traces');
  });

  it('short-circuits empty trace list', async () => {
    let called = false;
    global.fetch = vi.fn(async () => {
      called = true;
      return new Response();
    }) as typeof fetch;

    const exporter = new OtelExporter({
      endpoint: 'https://otel.example.com',
      serviceName: 'iris',
    });
    const res = await exporter.exportTraces([]);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
    expect(res.bytesSent).toBe(0);
    expect(called).toBe(false);
  });

  it('POSTs JSON payload to the collector and reports success', async () => {
    let captured: RequestInit = {};
    let capturedUrl = '';
    global.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      capturedUrl = url;
      captured = init;
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const exporter = new OtelExporter({
      endpoint: 'https://otel.example.com',
      serviceName: 'iris-test',
      headers: { authorization: 'Bearer abc' },
    });
    const res = await exporter.exportTraces([trace]);

    expect(capturedUrl).toBe('https://otel.example.com/v1/traces');
    expect(captured.method).toBe('POST');
    const headers = captured.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe('Bearer abc');

    const body = JSON.parse(captured.body as string);
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.bytesSent).toBeGreaterThan(0);
  });

  it('reports failure with status code + error text on 5xx', async () => {
    global.fetch = vi.fn(async () => new Response('upstream broken', { status: 503 })) as typeof fetch;

    const exporter = new OtelExporter({
      endpoint: 'https://otel.example.com',
      serviceName: 'iris',
    });
    const res = await exporter.exportTraces([trace]);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.error).toContain('503');
    expect(res.error).toContain('upstream broken');
  });

  it('does not throw on network abort — reports ok:false', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('connection reset');
    }) as typeof fetch;

    const exporter = new OtelExporter({
      endpoint: 'https://otel.example.com',
      serviceName: 'iris',
    });
    const res = await exporter.exportTraces([trace]);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toContain('connection reset');
  });
});

describe('exporterFromEnv', () => {
  it('returns null when IRIS_OTEL_ENDPOINT is unset', () => {
    delete process.env.IRIS_OTEL_ENDPOINT;
    expect(exporterFromEnv()).toBeNull();
  });

  it('returns an exporter when IRIS_OTEL_ENDPOINT is set', () => {
    process.env.IRIS_OTEL_ENDPOINT = 'https://otel.example.com';
    process.env.IRIS_OTEL_SERVICE_NAME = 'custom-svc';
    const exporter = exporterFromEnv();
    expect(exporter).not.toBeNull();
    // @ts-expect-error — reading private for test
    expect(exporter!.serviceName).toBe('custom-svc');
  });

  it('parses IRIS_OTEL_HEADERS into headers map', () => {
    process.env.IRIS_OTEL_ENDPOINT = 'https://otel.example.com';
    process.env.IRIS_OTEL_HEADERS = 'authorization=Bearer abc, x-tenant=foo,malformed,=noKey,noVal=';
    const exporter = exporterFromEnv();
    // @ts-expect-error — reading private for test
    const headers = exporter!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer abc');
    expect(headers['x-tenant']).toBe('foo');
    // Malformed entries skipped
    expect(headers.malformed).toBeUndefined();
    expect(headers['']).toBeUndefined();
    expect(headers.noVal).toBeUndefined();
  });

  it('respects IRIS_OTEL_TIMEOUT_MS', () => {
    process.env.IRIS_OTEL_ENDPOINT = 'https://otel.example.com';
    process.env.IRIS_OTEL_TIMEOUT_MS = '5000';
    const exporter = exporterFromEnv();
    // @ts-expect-error — reading private for test
    expect(exporter!.timeoutMs).toBe(5000);
  });

  it('uses default service name iris-mcp when IRIS_OTEL_SERVICE_NAME unset', () => {
    process.env.IRIS_OTEL_ENDPOINT = 'https://otel.example.com';
    delete process.env.IRIS_OTEL_SERVICE_NAME;
    const exporter = exporterFromEnv();
    // @ts-expect-error — reading private for test
    expect(exporter!.serviceName).toBe('iris-mcp');
  });
});
