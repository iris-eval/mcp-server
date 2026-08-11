# `@iris-eval/client` — SDK Specification

> **Status:** design spec. **Not implemented.** This is the design for the SDK item in **Track 3 (Reach)** of the [roadmap](./roadmap.md) — it is not a commitment to a date. The MCP-native path described below is the supported install today.
>
> **Why this exists:** Iris's primary install path is MCP-native — the MCP server runs as a subprocess and any MCP-aware client (Claude Code, Cursor, Windsurf, Continue, Cline, Zed, custom MCP clients) discovers it. That's the right fit for hosted agents. Teams building **custom agents** in TypeScript hit two limits: MCP's process-boundary cost on every call, and the fact that under MCP a tool call is always the model's decision — so capture is best-effort. In early testing one user wrote a 249-line ad-hoc bridge precisely because the MCP path did not fit their high-volume real-time loop. An in-process SDK is the right shape for that use case, and it makes capture unconditional.

## Goals

1. **Sub-20-line integration.** A new TS agent imports the SDK, instantiates it, and calls `evaluate()` per output. No subprocess. No serialization overhead.
2. **Feature parity with the MCP server.** Same rule library, same scoring, same dashboard storage, same configuration. The SDK is an alternate front door, not a different product.
3. **Zod-typed surface.** Every input + output is Zod-validated. Type safety + runtime safety + clear errors.
4. **Dashboard interop.** Traces written via the SDK appear on the same dashboard as MCP-server traces. No silos.

## Non-goals

- **Python SDK.** Out of scope for this spec. A Python client is listed under Track 3 alongside the TypeScript one; it should be a thin client over the same HTTP API rather than a second implementation of the eval engine.
- **Streaming evaluations.** v1 SDK evaluates per-output (synchronous). Streaming evaluation lands later if real demand emerges.
- **MCP server replacement.** The SDK does not deprecate the MCP server. Both are first-class install paths.

## Surface (proposed)

```ts
import { Iris } from '@iris-eval/client';

const iris = new Iris({
  database: './iris.db',                 // or: shared SQLite path with the MCP server's deployment
  rules: ['completeness', 'safety-pii', 'cost-budget'], // subset; default = all 13
  customRules: [],                       // optional: Zod-validated custom rules
});

const result = await iris.evaluate({
  agentName: 'support-bot',
  input: userPrompt,
  output: agentResponse,
  metadata: {
    model: 'claude-sonnet-4',
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    durationMs: elapsed,
  },
});

// result.scores  → per-rule scores in [0, 1]
// result.aggregate → weighted aggregate
// result.skipped → rules that couldn't evaluate (e.g., missing context)
// result.traceId → ID for the dashboard
```

## Class shape

```ts
export class Iris {
  constructor(opts: IrisOpts);

  /** Score a single agent output. Idempotent per (agentName, output) pair. */
  evaluate(input: EvaluateInput): Promise<EvaluateResult>;

  /** Replay a historical trace through the current rule set (drift detection). */
  replay(traceId: string, opts?: { rules?: string[] }): Promise<EvaluateResult>;

  /** Query the trace store. Same shape as the MCP server's `get_traces` tool. */
  getTraces(filters?: TraceFilters): Promise<Trace[]>;

  /** Close the database connection. Required at process exit for clean SQLite shutdown. */
  close(): Promise<void>;
}
```

## Configuration

```ts
interface IrisOpts {
  /** Path to the SQLite database. Created if missing. Shared with the MCP server's install when set to the same path. */
  database: string;

  /** Subset of built-in rules to enable. Default: all 13. */
  rules?: BuiltInRuleId[];

  /** Custom Zod-validated rule definitions. */
  customRules?: CustomRule[];

  /** Optional logger (defaults to no-op; pino-compatible). */
  logger?: Logger;

  /** Eval Tax budget in milliseconds. If exceeded, eval-skip is logged and `result.skipped` includes the over-budget rules. Default: 250ms. */
  evalTaxBudgetMs?: number;
}
```

## Error model

- **Validation errors** (input doesn't match schema): thrown synchronously from `evaluate()` before any DB write. Zod error message included.
- **Storage errors** (DB unavailable, disk full): thrown after retries (configurable; default 3 retries with backoff).
- **Rule errors** (a custom rule throws): the rule is skipped, the error is logged, the aggregate score includes only the rules that succeeded. The thrown error appears in `result.errors[]` for observability but doesn't fail the whole `evaluate()` call.

## Performance characteristics (target)

- **Cold start:** < 50ms (database open + rule registry load).
- **Per-evaluate latency (deterministic rules only):** < 10ms p99.
- **Per-evaluate latency (with one LLM-as-judge rule):** dominated by judge latency (~200-400ms typical).
- **Memory footprint:** < 30MB resident for default rule set + 1000-trace cache.
- **Throughput:** > 200 evals/sec on a single Node process for deterministic-only rules.

These are targets, not measurements. No benchmark has been run. If this ships, the numbers get measured and published rather than asserted — the same standard Track 1 applies to evaluator accuracy.

## Migration from MCP-server-only deployments

A team currently using `@iris-eval/mcp-server` who wants to switch to (or also use) the SDK:

1. Install `@iris-eval/client`.
2. Point the SDK at the same SQLite path the MCP server is using.
3. Both write to the same DB; both read from the same dashboard. No migration needed.

For shared-deployment scenarios, document the locking model. SQLite WAL handles concurrent writers within reason; a high-throughput SDK running alongside a concurrent MCP server is the case that would justify a Postgres adapter. The storage layer already sits behind an adapter interface, so that is an addition rather than a rewrite — but it is not currently being built.

## Open questions for implementation

- **Worker thread for judged rules?** Async judge calls block the event loop briefly. Worker offload reduces tail latency at the cost of one extra IPC hop. Spike during implementation.
- **TypeScript-only or also CommonJS?** Default plan: TypeScript-first ESM, with a CJS build via tsup for legacy consumers.
- **Rule registry plugin model?** Phase 1: `customRules: [...]` array on construct. Phase 2: npm-discoverable rules via `@iris-eval/rules-*` packages. Out of scope for the first implementation.

## Relationship to the MCP server

| Surface | Best for |
|---|---|
| `@iris-eval/mcp-server` | hosted clients (Claude Code, Cursor, Windsurf, Continue, Cline, Zed, custom MCP clients). One-config-file install. Discovers automatically. |
| `@iris-eval/client` | custom agents written in TypeScript. In-process, sub-millisecond setup, full programmatic API. |

Both share: rule library, dashboard, scoring algorithms, custom-rule format, storage. Migrating between them is a config change, not a rewrite.

## Where this sits on the roadmap

This spec is the design for the **SDK item in Track 3 (Reach)** — see [roadmap.md](./roadmap.md).

One thing has changed since the spec was written, and it strengthens the case rather than weakening it. The original motivation was *performance*: MCP's process boundary is costly in a high-volume loop. That still holds. But the more important reason is **capture reliability**: under MCP a tool call is always the model's decision, so a trace is recorded only if the agent chooses to record it. An in-process SDK makes capture unconditional.

That reframes the two front doors:

- **MCP** — discovery and interactive use. Zero-config, works in any MCP client, best-effort capture.
- **SDK** — programmatic use. Guaranteed capture, no process boundary.

Neither replaces the other, and both remain first-class.

Track 3 sequences the **HTTP write endpoints first** (`POST /traces`, `POST /evaluations`), because today MCP is the only path data can enter Iris at all. Once those exist, this SDK becomes a thin, well-typed client over a documented API rather than a parallel implementation of the same logic — which is the right shape, and less code to keep correct.
