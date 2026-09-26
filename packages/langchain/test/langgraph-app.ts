/*
 * A real LangGraph.js app with a scripted model, for the end-to-end tests —
 * the same script as the Python client's tests/langgraph_app.py.
 *
 * The graph is the canonical tool loop: a model node, LangGraph's own
 * ToolNode, and toolsCondition between them. Only the model is scripted, so
 * the run needs no key and gives the same result every time:
 *   asked about the weather → calls the first tool it was given, then answers
 *                             "It is 18 degrees and sunny in Paris."
 *   asked for an SSN        → "Her SSN is 123-45-6789."
 *   anything else           → "The capital of France is Paris."
 * Token usage: 10 in and 12 out for the tool request, 30 in and 8 out for the
 * answer after it; 10 in and 4 or 6 out for a direct answer.
 */
import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';

export const ANSWER = 'The capital of France is Paris.';
export const SSN = 'Her SSN is 123-45-6789.';
export const AFTER_TOOL = 'It is 18 degrees and sunny in Paris.';
export const MODEL = 'scripted-model';

interface ScriptedCallOptions extends BaseChatModelCallOptions {
  tools?: Array<{ type: 'function'; function: { name: string } }>;
}

const text = (m: BaseMessage): string => (typeof m.content === 'string' ? m.content : m.content.map((b) => ('text' in b ? String(b.text) : '')).join(' '));

export class ScriptedChatModel extends BaseChatModel<ScriptedCallOptions> {
  _llmType(): string {
    return 'scripted';
  }

  override getLsParams(options: this['ParsedCallOptions']) {
    return { ...super.getLsParams(options), ls_provider: 'scripted', ls_model_name: MODEL };
  }

  /** What a provider's chat model reports as the call's parameters (ChatOpenAI and ChatAnthropic include the tools). */
  override invocationParams(options?: this['ParsedCallOptions']) {
    return { model: MODEL, ...(options?.tools ? { tools: options.tools } : {}) };
  }

  override bindTools(tools: StructuredToolInterface[]) {
    return this.withConfig({ tools: tools.map((t) => convertToOpenAITool(t)) } as Partial<ScriptedCallOptions>);
  }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const last = messages[messages.length - 1];
    const asked = [...messages].reverse().find((m) => m.getType() === 'human');
    const ask = asked ? text(asked).toLowerCase() : '';
    const meta = { model_name: MODEL };
    let message: AIMessage;
    if (last instanceof ToolMessage) {
      message = new AIMessage({ content: AFTER_TOOL, usage_metadata: { input_tokens: 30, output_tokens: 8, total_tokens: 38 }, response_metadata: { ...meta, finish_reason: 'stop' } });
    } else if (options.tools && options.tools.length > 0 && ask.includes('weather')) {
      message = new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_weather_1', name: options.tools[0].function.name, args: { city: 'Paris' }, type: 'tool_call' }],
        usage_metadata: { input_tokens: 10, output_tokens: 12, total_tokens: 22 },
        response_metadata: { ...meta, finish_reason: 'tool_calls' },
      });
    } else if (ask.includes('ssn')) {
      message = new AIMessage({ content: SSN, usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }, response_metadata: { ...meta, finish_reason: 'stop' } });
    } else {
      message = new AIMessage({ content: ANSWER, usage_metadata: { input_tokens: 10, output_tokens: 6, total_tokens: 16 }, response_metadata: { ...meta, finish_reason: 'stop' } });
    }
    return { generations: [{ message, text: typeof message.content === 'string' ? message.content : '' }] };
  }
}

export const getWeather = tool(async ({ city }: { city: string }) => `18C, sunny in ${city}`, {
  name: 'get_weather',
  description: 'The weather in a city.',
  schema: z.object({ city: z.string() }),
});

export const brokenWeather = tool(
  async ({ city }: { city: string }): Promise<string> => {
    throw new Error(`the weather service is down for ${city}`);
  },
  { name: 'broken_weather', description: 'The weather in a city, from a service that is down.', schema: z.object({ city: z.string() }) },
);

/** The tool loop: model → tools → model, until the model answers without a tool call. */
export function buildGraph(tools: StructuredToolInterface[] = [getWeather], compileOptions: Parameters<StateGraph<typeof MessagesAnnotation>['compile']>[0] = {}) {
  const model = new ScriptedChatModel({}).bindTools(tools);
  return new StateGraph(MessagesAnnotation)
    .addNode('agent', async (state) => ({ messages: [await model.invoke(state.messages)] }))
    .addNode('tools', new ToolNode(tools, { handleToolErrors: false }))
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', toolsCondition, ['tools', END])
    .addEdge('tools', 'agent')
    .compile(compileOptions);
}
