/*
 * OTLP/HTTP protobuf → the OTLP/JSON object the JSON door already parses.
 *
 * The Python OTLP exporter sends protobuf only (its JSON encoder is not
 * implemented — the spec's compliance matrix says so), so until 0.16.0 no
 * Python framework reached `POST /v1/traces` without a Collector between.
 * Three ways to read protobuf were compared: protobufjs (reflection over
 * vendored .proto files; 3.8 MB unpacked), @bufbuild/protobuf (generated
 * code, a build step; 1.9 MB), or this — a wire-format reader for the one
 * message Iris accepts, ExportTraceServiceRequest, about two hundred lines
 * and no dependency. It produces exactly the proto3 JSON mapping as OTLP
 * specifies it (lowerCamelCase keys, 64-bit integers as decimal strings,
 * enums as integers, trace and span ids as hex), so everything downstream
 * — the zod schema, the mapping, the tests — is the JSON path unchanged.
 *
 * Field numbers are opentelemetry-proto v1 (trace/v1/trace.proto,
 * common/v1/common.proto, resource/v1/resource.proto,
 * collector/trace/v1/trace_service.proto). Unknown fields are skipped by
 * wire type, as every protobuf reader must; a malformed buffer throws
 * OtlpProtobufError with the byte offset.
 */

export class OtlpProtobufError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} (at byte ${offset})`);
    this.name = 'OtlpProtobufError';
  }
}

type JsonObject = Record<string, unknown>;

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end: number = buf.length) {}

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.end) throw new OtlpProtobufError('truncated varint', this.pos);
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new OtlpProtobufError('varint longer than 10 bytes', this.pos);
    }
  }

  fixed64(): bigint {
    if (this.pos + 8 > this.end) throw new OtlpProtobufError('truncated fixed64', this.pos);
    let v = 0n;
    for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(this.buf[this.pos + i]);
    this.pos += 8;
    return v;
  }

  fixed32(): number {
    if (this.pos + 4 > this.end) throw new OtlpProtobufError('truncated fixed32', this.pos);
    const v = this.buf[this.pos] | (this.buf[this.pos + 1] << 8) | (this.buf[this.pos + 2] << 16) | ((this.buf[this.pos + 3] << 24) >>> 0);
    this.pos += 4;
    return v >>> 0;
  }

  double(): number {
    if (this.pos + 8 > this.end) throw new OtlpProtobufError('truncated double', this.pos);
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  }

  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (this.pos + len > this.end) throw new OtlpProtobufError(`length-delimited field runs past the buffer (${len} bytes)`, this.pos);
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(): string {
    return new TextDecoder('utf-8').decode(this.bytes());
  }

  /** Reads a tag; returns [fieldNumber, wireType]. */
  tag(): [number, number] {
    const at = this.pos;
    const t = this.varint();
    const field = Number(t >> 3n);
    if (field === 0) throw new OtlpProtobufError('field number 0 is not a protobuf field', at);
    return [field, Number(t & 7n)];
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0: this.varint(); return;
      case 1: this.fixed64(); return;
      case 2: this.bytes(); return;
      case 5: this.fixed32(); return;
      default: throw new OtlpProtobufError(`unsupported wire type ${wireType}`, this.pos);
    }
  }

  sub(): Reader {
    const b = this.bytes();
    return new Reader(b, b.length);
  }
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const base64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
/** int64 varints are two's complement over 64 bits; a top bit set is negative. */
const int64 = (v: bigint): string => (v >= 1n << 63n ? v - (1n << 64n) : v).toString();

function anyValue(r: Reader): JsonObject {
  const out: JsonObject = {};
  while (!r.done) {
    const [field, wt] = r.tag();
    switch (field) {
      case 1: out.stringValue = r.string(); break;
      case 2: out.boolValue = r.varint() !== 0n; break;
      case 3: out.intValue = int64(r.varint()); break;
      case 4: out.doubleValue = r.double(); break;
      case 5: out.arrayValue = arrayValue(r.sub()); break;
      case 6: out.kvlistValue = kvlistValue(r.sub()); break;
      case 7: out.bytesValue = base64(r.bytes()); break;
      default: r.skip(wt);
    }
  }
  return out;
}

/** ArrayValue { repeated AnyValue values = 1 } — an empty list is omitted, as proto3 JSON omits it. */
function arrayValue(r: Reader): JsonObject {
  const values: JsonObject[] = [];
  while (!r.done) {
    const [field, wt] = r.tag();
    if (field === 1) values.push(anyValue(r.sub()));
    else r.skip(wt);
  }
  return values.length > 0 ? { values } : {};
}

/** KeyValueList { repeated KeyValue values = 1 }. */
function kvlistValue(r: Reader): JsonObject {
  const values: JsonObject[] = [];
  while (!r.done) {
    const [field, wt] = r.tag();
    if (field === 1) values.push(keyValue(r.sub()));
    else r.skip(wt);
  }
  return values.length > 0 ? { values } : {};
}

function keyValue(r: Reader): JsonObject {
  const out: JsonObject = {};
  while (!r.done) {
    const [field, wt] = r.tag();
    switch (field) {
      case 1: out.key = r.string(); break;
      case 2: out.value = anyValue(r.sub()); break;
      default: r.skip(wt);
    }
  }
  return out;
}

function keyValues(r: Reader, into: JsonObject, key: string): void {
  const list = (into[key] as JsonObject[] | undefined) ?? [];
  list.push(keyValue(r.sub()));
  into[key] = list;
}

function event(r: Reader): JsonObject {
  const out: JsonObject = {};
  while (!r.done) {
    const [field, wt] = r.tag();
    switch (field) {
      case 1: out.timeUnixNano = r.fixed64().toString(); break;
      case 2: out.name = r.string(); break;
      case 3: keyValues(r, out, 'attributes'); break;
      case 4: { const n = Number(r.varint()); if (n) out.droppedAttributesCount = n; break; }
      default: r.skip(wt);
    }
  }
  return out;
}

function link(r: Reader): JsonObject {
  const out: JsonObject = {};
  while (!r.done) {
    const [field, wt] = r.tag();
    switch (field) {
      case 1: out.traceId = hex(r.bytes()); break;
      case 2: out.spanId = hex(r.bytes()); break;
      case 3: out.traceState = r.string(); break;
      case 4: keyValues(r, out, 'attributes'); break;
      case 5: { const n = Number(r.varint()); if (n) out.droppedAttributesCount = n; break; }
      case 6: { const n = r.fixed32(); if (n) out.flags = n; break; }
      default: r.skip(wt);
    }
  }
  return out;
}

function status(r: Reader): JsonObject {
  const out: JsonObject = {};
  while (!r.done) {
    const [field, wt] = r.tag();
    switch (field) {
      case 2: out.message = r.string(); break;
      case 3: { const n = Number(r.varint()); if (n) out.code = n; break; }
      default: r.skip(wt);
    }
  }
  return out;
}

function span(r: Reader): JsonObject {
  const out: JsonObject = {};
  while (!r.done) {
    const [field, wt] = r.tag();
    switch (field) {
      case 1: out.traceId = hex(r.bytes()); break;
      case 2: out.spanId = hex(r.bytes()); break;
      case 3: out.traceState = r.string(); break;
      case 4: out.parentSpanId = hex(r.bytes()); break;
      case 5: out.name = r.string(); break;
      case 6: { const n = Number(r.varint()); if (n) out.kind = n; break; }
      case 7: out.startTimeUnixNano = r.fixed64().toString(); break;
      case 8: out.endTimeUnixNano = r.fixed64().toString(); break;
      case 9: keyValues(r, out, 'attributes'); break;
      case 10: { const n = Number(r.varint()); if (n) out.droppedAttributesCount = n; break; }
      case 11: { const list = (out.events as JsonObject[] | undefined) ?? []; list.push(event(r.sub())); out.events = list; break; }
      case 12: { const n = Number(r.varint()); if (n) out.droppedEventsCount = n; break; }
      case 13: { const list = (out.links as JsonObject[] | undefined) ?? []; list.push(link(r.sub())); out.links = list; break; }
      case 14: { const n = Number(r.varint()); if (n) out.droppedLinksCount = n; break; }
      case 15: out.status = status(r.sub()); break;
      case 16: { const n = r.fixed32(); if (n) out.flags = n; break; }
      default: r.skip(wt);
    }
  }
  return out;
}

function scope(r: Reader): JsonObject {
  const out: JsonObject = {};
  while (!r.done) {
    const [field, wt] = r.tag();
    switch (field) {
      case 1: out.name = r.string(); break;
      case 2: out.version = r.string(); break;
      case 3: keyValues(r, out, 'attributes'); break;
      case 4: { const n = Number(r.varint()); if (n) out.droppedAttributesCount = n; break; }
      default: r.skip(wt);
    }
  }
  return out;
}

function scopeSpans(r: Reader): JsonObject {
  const out: JsonObject = {};
  while (!r.done) {
    const [field, wt] = r.tag();
    switch (field) {
      case 1: out.scope = scope(r.sub()); break;
      case 2: { const list = (out.spans as JsonObject[] | undefined) ?? []; list.push(span(r.sub())); out.spans = list; break; }
      case 3: out.schemaUrl = r.string(); break;
      default: r.skip(wt);
    }
  }
  return out;
}

function resource(r: Reader): JsonObject {
  const out: JsonObject = {};
  while (!r.done) {
    const [field, wt] = r.tag();
    switch (field) {
      case 1: keyValues(r, out, 'attributes'); break;
      case 2: { const n = Number(r.varint()); if (n) out.droppedAttributesCount = n; break; }
      default: r.skip(wt);
    }
  }
  return out;
}

function resourceSpans(r: Reader): JsonObject {
  const out: JsonObject = {};
  while (!r.done) {
    const [field, wt] = r.tag();
    switch (field) {
      case 1: out.resource = resource(r.sub()); break;
      case 2: { const list = (out.scopeSpans as JsonObject[] | undefined) ?? []; list.push(scopeSpans(r.sub())); out.scopeSpans = list; break; }
      case 3: out.schemaUrl = r.string(); break;
      default: r.skip(wt);
    }
  }
  return out;
}

/**
 * Decode an OTLP ExportTraceServiceRequest (protobuf wire format) into the
 * OTLP/JSON object: `{ resourceSpans: [...] }`. Throws OtlpProtobufError on
 * a malformed buffer.
 */
export function decodeExportTraceServiceRequest(bytes: Uint8Array): { resourceSpans: JsonObject[] } {
  const r = new Reader(bytes);
  const out: { resourceSpans: JsonObject[] } = { resourceSpans: [] };
  while (!r.done) {
    const [field, wt] = r.tag();
    if (field === 1) out.resourceSpans.push(resourceSpans(r.sub()));
    else r.skip(wt);
  }
  return out;
}
