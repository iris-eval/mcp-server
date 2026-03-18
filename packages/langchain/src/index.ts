/**
 * @iris-eval/langchain
 *
 * Auto-trace LangChain agent runs with Iris MCP-native observability.
 * Implements LangChain's BaseCallbackHandler to capture execution traces.
 */

export interface IrisLangChainConfig {
  /** Iris MCP server URL for HTTP transport */
  serverUrl?: string;
  /** Agent name to use in traces (defaults to chain name) */
  agentName?: string;
  /** Whether to capture LLM input/output content (default: true) */
  captureContent?: boolean;
  /** Whether to auto-evaluate output (default: false) */
  autoEval?: boolean;
  /** Eval type to use if autoEval is true */
  evalType?: 'completeness' | 'relevance' | 'safety' | 'cost';
}

interface SpanData {
  name: string;
  kind: string;
  startTime: number;
  attributes: Record<string, unknown>;
}

/**
 * LangChain callback handler that sends traces to Iris.
 *
 * Usage:
 * ```typescript
 * import { IrisCallbackHandler } from '@iris-eval/langchain';
 *
 * const iris = new IrisCallbackHandler({ serverUrl: 'http://localhost:3838' });
 * const result = await chain.invoke({ input: "..." }, { callbacks: [iris] });
 * ```
 */
export class IrisCallbackHandler {
  private config: Required<IrisLangChainConfig>;
  private spans: Map<string, SpanData> = new Map();
  private toolCalls: Array<Record<string, unknown>> = [];
  private startTime: number = 0;
  private input: string = '';
  private tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  constructor(config: IrisLangChainConfig = {}) {
    this.config = {
      serverUrl: config.serverUrl || 'http://localhost:3838',
      agentName: config.agentName || 'langchain-agent',
      captureContent: config.captureContent ?? true,
      autoEval: config.autoEval ?? false,
      evalType: config.evalType || 'safety',
    };
  }

  async handleChainStart(chain: { name?: string }, inputs: Record<string, unknown>): Promise<void> {
    this.startTime = Date.now();
    this.input = JSON.stringify(inputs);
    this.spans.clear();
    this.toolCalls = [];
    this.tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    if (chain.name) {
      this.config.agentName = chain.name;
    }
  }

  async handleLLMStart(_llm: Record<string, unknown>, prompts: string[], runId: string): Promise<void> {
    this.spans.set(runId, {
      name: 'llm_call',
      kind: 'llm',
      startTime: Date.now(),
      attributes: { prompt_length: prompts.join('').length },
    });
  }

  async handleLLMEnd(output: Record<string, unknown>, runId: string): Promise<void> {
    const span = this.spans.get(runId);
    if (span) {
      span.attributes.duration_ms = Date.now() - span.startTime;
    }

    // Accumulate token usage if available
    const usage = (output as Record<string, Record<string, number>>)?.llmOutput?.tokenUsage;
    if (usage) {
      this.tokenUsage.prompt_tokens += usage.promptTokens || 0;
      this.tokenUsage.completion_tokens += usage.completionTokens || 0;
      this.tokenUsage.total_tokens += (usage.promptTokens || 0) + (usage.completionTokens || 0);
    }
  }

  async handleToolStart(tool: { name?: string }, input: string, runId: string): Promise<void> {
    this.spans.set(runId, {
      name: tool.name || 'unknown_tool',
      kind: 'tool',
      startTime: Date.now(),
      attributes: { input },
    });
  }

  async handleToolEnd(output: string, runId: string): Promise<void> {
    const span = this.spans.get(runId);
    if (span) {
      const duration = Date.now() - span.startTime;
      this.toolCalls.push({
        tool_name: span.name,
        input: span.attributes.input,
        output,
        duration_ms: duration,
        status: 'success',
      });
    }
  }

  async handleChainEnd(outputs: Record<string, unknown>): Promise<void> {
    const latency = Date.now() - this.startTime;
    const output = JSON.stringify(outputs);

    // Estimate cost (rough, based on token counts)
    const costUsd = this.tokenUsage.prompt_tokens * 0.000015 + this.tokenUsage.completion_tokens * 0.00006;

    const trace = {
      agent_name: this.config.agentName,
      framework: 'langchain',
      input: this.config.captureContent ? this.input : '[redacted]',
      output: this.config.captureContent ? output : '[redacted]',
      latency_ms: latency,
      token_usage: this.tokenUsage,
      cost_usd: parseFloat(costUsd.toFixed(4)),
      tool_calls: this.toolCalls,
      spans: Array.from(this.spans.values()).map((s) => ({
        name: s.name,
        kind: s.kind,
        duration_ms: (s.attributes.duration_ms as number) || Date.now() - s.startTime,
        status: 'ok',
      })),
    };

    // Send trace to Iris via HTTP
    try {
      await fetch(`${this.config.serverUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: 'log_trace', arguments: trace },
        }),
      });
    } catch {
      // Silently fail — observability should never break the application
    }
  }

  async handleChainError(error: Error): Promise<void> {
    const latency = Date.now() - this.startTime;

    try {
      await fetch(`${this.config.serverUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: 'log_trace',
            arguments: {
              agent_name: this.config.agentName,
              framework: 'langchain',
              input: this.input,
              output: `ERROR: ${error.message}`,
              latency_ms: latency,
              metadata: { error: true, error_type: error.name, error_message: error.message },
            },
          },
        }),
      });
    } catch {
      // Silently fail
    }
  }
}
