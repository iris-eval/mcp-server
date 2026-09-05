/*
 * The one prompt: `evaluate-my-agent`. A client that supports prompts
 * shows it as a slash command; a client that does not never sees it, and
 * nothing in the README depends on it. Rendered from the same facts as
 * the server instructions (src/instructions.ts) and carrying the version,
 * so a cached copy cannot outlive a bump.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EVALUATE_MY_AGENT_PROMPT, evaluateMyAgentPrompt } from './instructions.js';

export const PROMPT_NAMES = [EVALUATE_MY_AGENT_PROMPT] as const;

export function registerPrompts(server: McpServer, version: string): void {
  server.registerPrompt(
    EVALUATE_MY_AGENT_PROMPT,
    {
      title: 'Evaluate my agent',
      description: 'A walk through logging an agent run, evaluating it and reading the verdict with Iris, in plain words.',
      argsSchema: {
        what: z
          .string()
          .optional()
          .describe('"output" (default): you have an agent output to hand; "trace-file": you have a file of runs to evaluate'),
      },
    },
    ({ what }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: evaluateMyAgentPrompt(what === 'trace-file' ? 'trace-file' : 'output', version) },
        },
      ],
    }),
  );
}
