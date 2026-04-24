import { describe, it, expect, vi, afterEach } from 'vitest';
import { bestEffortExport, __resetExporterForTests, getLazyExporter } from '../../../src/otel/lazy.js';
import { OtelExporter } from '../../../src/otel/exporter.js';
import type { Trace } from '../../../src/types/trace.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  __resetExporterForTests();
});

const trace: Trace = {
  trace_id: '00000000000000000000000000000001',
  agent_name: 'test',
  timestamp: '2026-04-24T12:00:00Z',
};

describe('lazy OTel exporter', () => {
  it('returns null when endpoint not configured', () => {
    delete process.env.IRIS_OTEL_ENDPOINT;
    __resetExporterForTests();
    expect(getLazyExporter()).toBeNull();
  });

  it('memoizes the result across calls', () => {
    process.env.IRIS_OTEL_ENDPOINT = 'https://otel.example.com';
    __resetExporterForTests();
    const a = getLazyExporter();
    const b = getLazyExporter();
    expect(a).toBe(b);
  });

  it('bestEffortExport no-ops when no exporter configured', async () => {
    delete process.env.IRIS_OTEL_ENDPOINT;
    __resetExporterForTests();
    // Should not throw, not call any callback.
    let errored = false;
    bestEffortExport(trace, () => {
      errored = true;
    });
    // Give any hypothetical promise a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(errored).toBe(false);
  });

  it('bestEffortExport forwards errors to onError callback', async () => {
    process.env.IRIS_OTEL_ENDPOINT = 'https://otel.example.com';
    const stubExporter = {
      exportTraces: vi.fn(async () => ({
        ok: false,
        status: 503,
        bytesSent: 0,
        latencyMs: 5,
        error: 'upstream broken',
      })),
    } as unknown as OtelExporter;
    __resetExporterForTests(stubExporter);

    let caught: Error | undefined;
    bestEffortExport(trace, (err) => {
      caught = err;
    });

    // Allow the microtask queue to flush
    await new Promise((r) => setTimeout(r, 10));
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('503');
    expect(caught!.message).toContain('upstream broken');
  });

  it('bestEffortExport does not throw on exporter crash', async () => {
    process.env.IRIS_OTEL_ENDPOINT = 'https://otel.example.com';
    const stubExporter = {
      exportTraces: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as OtelExporter;
    __resetExporterForTests(stubExporter);

    let caught: Error | undefined;
    // Must not throw synchronously even if the exporter rejects.
    expect(() =>
      bestEffortExport(trace, (err) => {
        caught = err;
      }),
    ).not.toThrow();

    await new Promise((r) => setTimeout(r, 10));
    expect(caught?.message).toBe('boom');
  });
});
