import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { registerEvaluateOutputTool } from '../../../src/tools/evaluate-output.js';

describe('evaluate_output tool', () => {
  let server: McpServer;
  let storage: SqliteAdapter;
  let evalEngine: EvalEngine;

  beforeEach(async () => {
    server = new McpServer({ name: 'test', version: '0.1.0' });
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    evalEngine = new EvalEngine(0.7);
    registerEvaluateOutputTool(server, storage, evalEngine);
  });

  afterEach(async () => {
    await storage.close();
  });

  it('should register the evaluate_output tool', () => {
    expect(server).toBeDefined();
  });

  it('should evaluate output using the engine', () => {
    const result = evalEngine.evaluate('completeness', {
      output: 'This is a good and complete response with multiple sentences. It covers the topic well.',
    });
    expect(result.score).toBeGreaterThan(0);
    expect(result.rule_results.length).toBeGreaterThan(0);
  });

  it('should evaluate with custom rules', () => {
    const result = evalEngine.evaluate('custom', { output: 'Hello world' }, [
      { name: 'has_hello', type: 'contains_keywords', config: { keywords: ['hello'] } },
    ]);
    expect(result.passed).toBe(true);
  });

  it('should handle all eval types', () => {
    for (const type of ['completeness', 'relevance', 'safety', 'cost'] as const) {
      const result = evalEngine.evaluate(type, { output: 'Test output for evaluation' });
      expect(result.eval_type).toBe(type);
    }
  });
});
