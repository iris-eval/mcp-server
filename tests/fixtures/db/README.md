# Databases written by released versions

The migration tests open copies of these files with the current build, so an upgrade is proven on a database a real release wrote rather than on one rolled back by hand.

| File | Written by | What it holds |
|---|---|---|
| `iris-0.19.0.db` | the `v0.19.0` tag's own `SqliteAdapter` and OTLP mapper (migrations 001–014, `writer_version` 0.19.0) | three traces: one that reported a cost ($0.0123), one sent over OTLP with 150,000 input and 10,000 output tokens of `gpt-4o-mini` and no cost, one with neither |

To write `iris-0.19.0.db` again: check out `v0.19.0` in a separate worktree, install its dependencies, save the script below as `make-fixture.ts` at its root, and run `npx tsx make-fixture.ts <path>/iris-0.19.0.db` with a throwaway `IRIS_HOME`. Then set `journal_mode = DELETE` and `VACUUM` the file so it is one self-contained file.

```ts
import { rmSync } from 'node:fs';
import { SqliteAdapter } from './src/storage/sqlite-adapter.js';
import { fromOtlp, otlpTraceRequestSchema } from './src/otel/ingest.js';
import { LOCAL_TENANT } from './src/types/tenant.js';

const out = process.argv[2];
rmSync(out, { force: true });
const store = new SqliteAdapter(out);
await store.initialize();
await store.insertTrace(LOCAL_TENANT, {
  trace_id: '0190a000000000000000000000000001', agent_name: 'reported-bot',
  input: 'What is the refund window?', output: 'Thirty days from delivery.',
  token_usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 },
  cost_usd: 0.0123, metadata: { model: 'gpt-4o' }, timestamp: '2026-09-24T10:00:00.000Z', source: 'http',
});
const otlp = otlpTraceRequestSchema.parse({ resourceSpans: [{
  resource: { attributes: [{ key: 'service.name', value: { stringValue: 'otel-bot' } }] },
  scopeSpans: [{ scope: { name: 'openai' }, spans: [{
    traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', name: 'chat gpt-4o-mini',
    startTimeUnixNano: '1758708000000000000', endTimeUnixNano: '1758708001000000000',
    attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
      { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o-mini' } },
      { key: 'gen_ai.response.model', value: { stringValue: 'gpt-4o-mini-2024-07-18' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: 150000 } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: 10000 } },
      { key: 'gen_ai.output.messages', value: { stringValue: 'The report is attached.' } },
    ],
  }] }],
}] });
const mapped = fromOtlp(otlp, { mintTraceId: () => '0190a000000000000000000000000002', mintSpanId: () => '0190a00000000002' });
await store.insertTraces(LOCAL_TENANT, mapped.traces.map((m) => m.trace));
await store.insertTrace(LOCAL_TENANT, {
  trace_id: '0190a000000000000000000000000003', agent_name: 'plain-bot',
  input: 'hello', output: 'hi', timestamp: '2026-09-24T10:02:00.000Z', source: 'tool',
});
await store.close();
```
