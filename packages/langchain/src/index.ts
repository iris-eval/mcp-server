/*
 * @iris-eval/langchain — send each LangChain.js or LangGraph.js run to Iris as
 * one OpenTelemetry trace and get its verdict.
 *
 *   import { IrisCallbackHandler } from '@iris-eval/langchain';
 *   await graph.invoke(input, { callbacks: [new IrisCallbackHandler({ agentName: 'support-bot' })] });
 */
export { IrisCallbackHandler, type IrisCallbackHandlerOptions } from './handler.js';
