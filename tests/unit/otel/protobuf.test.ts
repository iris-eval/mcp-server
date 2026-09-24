/*
 * The protobuf door decodes what the Python exporter sends.
 *
 * The fixtures are REAL: `tests/fixtures/otlp/python-genai.pb` and
 * `python-plain.pb` are the request bodies opentelemetry-exporter-otlp-proto-http
 * 1.44.0 (opentelemetry-sdk 1.44.0, protobuf 7.36.2) posted to a capturing
 * server on 2026-09-21; the `.otlp.json` beside each is the same message
 * through protobuf's own JSON mapping (`MessageToDict`, integer enums) with
 * the ids hex-encoded as OTLP/JSON requires. The decoder must reproduce
 * that object exactly — then everything downstream is the JSON path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeExportTraceServiceRequest, OtlpProtobufError } from '../../../src/otel/protobuf.js';
import { fromOtlp, otlpTraceRequestSchema } from '../../../src/otel/ingest.js';

const dir = resolve(import.meta.dirname, '../../fixtures/otlp');
const pb = (name: string) => new Uint8Array(readFileSync(join(dir, `${name}.pb`)));
const twin = (name: string) => JSON.parse(readFileSync(join(dir, `${name}.otlp.json`), 'utf8')) as unknown;

describe('OTLP protobuf → OTLP/JSON', () => {
  for (const name of ['python-genai', 'python-plain']) {
    it(`${name}.pb decodes to exactly its OTLP/JSON twin`, () => {
      expect(decodeExportTraceServiceRequest(pb(name))).toEqual(twin(name));
    });
  }

  it('the decoded GenAI fixture maps like the JSON one: agent, model, tokens, the tool call, the output', () => {
    const parsed = otlpTraceRequestSchema.parse(decodeExportTraceServiceRequest(pb('python-genai')));
    const mapped = fromOtlp(parsed);
    expect(mapped.traces).toHaveLength(1);
    const { trace, lacked } = mapped.traces[0];
    expect(trace.agent_name).toBe('billing-agent');
    expect(trace.output).toContain('Refunded order 8812');
    expect(trace.token_usage?.prompt_tokens).toBe(812 + 930);
    expect(trace.token_usage?.completion_tokens).toBe(96 + 40);
    expect(trace.spans?.some((s) => s.kind === 'TOOL')).toBe(true);
    expect(lacked).toEqual([]);
  });

  it('the plain fixture is stored with what it carries and says what it lacked', () => {
    const parsed = otlpTraceRequestSchema.parse(decodeExportTraceServiceRequest(pb('python-plain')));
    const { trace, lacked } = fromOtlp(parsed).traces[0];
    expect(trace.agent_name).toBe('plain-service');
    expect(trace.output).toBeUndefined();
    expect(lacked.length).toBeGreaterThan(0);
  });

  it('a malformed buffer is refused with the byte offset, never a partial trace', () => {
    const good = pb('python-plain');
    const truncated = good.subarray(0, good.length - 40);
    expect(() => decodeExportTraceServiceRequest(truncated)).toThrow(OtlpProtobufError);
    const garbage = new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
    expect(() => decodeExportTraceServiceRequest(garbage)).toThrow(/varint|past the buffer/);
  });

  it('an empty request is an empty resourceSpans list', () => {
    expect(decodeExportTraceServiceRequest(new Uint8Array())).toEqual({ resourceSpans: [] });
  });
});
