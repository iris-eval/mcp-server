/*
 * @iris-eval/sdk — record every model call your application makes, and get
 * Iris's verdict on it, with no change to the calls themselves.
 *
 *   import OpenAI from 'openai';
 *   import { wrapOpenAI } from '@iris-eval/sdk';
 *
 *   const openai = wrapOpenAI(new OpenAI(), { agentName: 'support-bot' });
 *   await openai.chat.completions.create({ model: 'gpt-5.2', messages });   // recorded, and scored by Iris
 *
 * Each call becomes an OpenTelemetry GenAI span sent to Iris's OTLP ingest
 * (`POST /v1/traces`). See the README for what is recorded and how.
 */
export { wrapOpenAI, wrapAnthropic, recordingFetch, resourceFor, type WrapOptions } from './wrap.js';
export { irisMiddleware, type IrisMiddlewareOptions, type IrisLanguageModelMiddleware } from './ai-sdk.js';
export {
  IrisRecorder,
  defaultRecorder,
  exportRequest,
  findServer,
  programName,
  newSpanId,
  newTraceId,
  nowNanos,
  type EvalType,
  type RecorderOptions,
  type RecorderStats,
  type SpanRecord,
  type StoredTrace,
  type TraceRecord,
} from './recorder.js';
export { MAX_PART_CHARS, genAiSpan, inputMessages, outputMessages, inputText, outputText, assemblerFor, type Api, type AttributeValue, type Attributes, type CallRecord, type Message, type Part } from './genai.js';
export { SDK_NAME, SDK_VERSION } from './version.js';
