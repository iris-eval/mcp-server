# `@iris-eval/client` — SDK Specification

> **Status:** spec for v0.4 — D4 lock per `plans/master-plan/think-risk-decision-register.md` Tier A Wave 2 — A7. Implementation ships in v0.4.0 (target 2026-06-09).
>
> **Why this exists:** Iris's primary install path is MCP-native — the MCP server runs as a subprocess and any MCP-aware client (Claude Code, Cursor, Windsurf, Continue, Cline, Zed, custom MCP clients) discovers it. That's the right fit for hosted agents. Teams building **custom agents** in TypeScript, however, hit MCP's process-boundary cost on every call. UAT evidence (`memory/iris_first_live_testing.md`: a 249-line ad-hoc bridge a customer wrote because the MCP path was too slow for their high-volume real-time loop) makes the case directly: an in-process SDK is the right shape for that use case.

## Goals

1. **Sub-20-line integration.** A new TS agent imports the SDK, instantiates it, and calls `evaluate()` per output. No subprocess. No serialization overhead.
2. **Feature parity with the MCP server.** Same rule library, same scoring, same dashboard storage, same configuration. The SDK is an alternate front door, not a different product.
3. **Zod-typed surface.** Every input + output is Zod-validated. Type safety + runtime safety + clear errors.
4. **Dashboard interop.** Traces written via the SDK appear on the same dashboard as MCP-server traces. No silos.

## Non-goals

- **Python SDK.** Out of scope for v0.4; planned for v0.5.
- **Streaming evaluations.** v1 SDK evaluates per-output (synchronous). Streaming evaluation lands later if real demand emerges.
- **MCP server replacement.** The SDK does not deprecate the MCP server. Both are first-class install paths.

## Surface (proposed)

```ts
import { Iris } from '@iris-eval/client';

const iris = new Iris({
  database: './iris.db',                 // or: shared SQLite path with the MCP server's deployment
  rules: ['completeness', 'safety-pii', 'cost-budget'], // subset; default = all 12
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

  /** Subset of built-in rules to enable. Default: all 12. */
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

These targets establish the v0.4 perf bar; benchmarks ship with v0.4 release notes.

## Migration from MCP-server-only deployments

A team currently using `@iris-eval/mcp-server` who wants to switch to (or also use) the SDK:

1. Install `@iris-eval/client`.
2. Point the SDK at the same SQLite path the MCP server is using.
3. Both write to the same DB; both read from the same dashboard. No migration needed.

For shared-deployment scenarios, document the locking model (SQLite WAL handles concurrent writers within reason; high-throughput SDK + concurrent MCP server may require Postgres backend planned for v0.5+ Cloud Starter).

## Open questions for v0.4 implementation

- **Worker thread for judged rules?** Async judge calls block the event loop briefly. Worker offload reduces tail latency at the cost of one extra IPC hop. Spike during v0.4 implementation.
- **TypeScript-only or also CommonJS?** Default plan: TypeScript-first ESM, with a CJS build via tsup for legacy consumers. Confirm during v0.4 build.
- **Rule registry plugin model?** Phase 1: `customRules: [...]` array on construct. Phase 2 (post-v0.4): npm-discoverable rules via `@iris-eval/rules-*` packages. Out of scope for v0.4.

## Relationship to the MCP server

| Surface | Best for |
|---|---|
| `@iris-eval/mcp-server` | hosted clients (Claude Code, Cursor, Windsurf, Continue, Cline, Zed, custom MCP clients). One-config-file install. Discovers automatically. |
| `@iris-eval/client` | custom agents written in TypeScript. In-process, sub-millisecond setup, full programmatic API. |

Both share: rule library, dashboard, scoring algorithms, custom-rule format, storage. Migrating between them is a config change, not a rewrite.

## Sources

- `plans/master-plan/think-risk-decision-register.md` D4 lock (Tier A Wave 2 — A7).
- `plans/master-plan/build-product-optimization.md` v0.4 list (P11 SDK ship).
- `memory/iris_first_live_testing.md` (UAT evidence motivating the SDK).
- `strategy/brand/per-client-docs/sdk-consumers.md` (parallel docs for SDK consumer clients).
