/*
 * The mapping's edges, the ones the end-to-end run does not reach: what is
 * never carried, what is cut, how cached tokens are counted, and a stream
 * cut short.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assemblerFor, genAiSpan, inputMessages } from '../src/index.js';

describe('the GenAI span', () => {
  it('an image is named by its type and its bytes never leave the process', () => {
    const messages = inputMessages('chat', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What is in this picture?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    });
    assert.deepEqual(messages[0].parts, [{ type: 'text', content: 'What is in this picture?' }, { type: 'image_url' }]);
    const anthropic = inputMessages('messages', { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }] }] });
    assert.deepEqual(anthropic[0].parts, [{ type: 'image' }]);
  });

  it('a long text part is cut, and says how much was left out', () => {
    const long = 'x'.repeat(20_000);
    const span = genAiSpan({ api: 'chat', request: { model: 'm', messages: [{ role: 'user', content: long }] } });
    const input = String(span.attributes['iris.input']);
    assert.ok(input.length < 17_000);
    assert.match(input, /… \[3616 more characters not recorded\]$/);
  });

  it('Anthropic cached tokens are counted inside input_tokens, as the conventions count them', () => {
    const span = genAiSpan({
      api: 'messages',
      request: { model: 'claude', messages: [{ role: 'user', content: 'hi' }] },
      response: { id: 'msg_1', model: 'claude', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } },
    });
    assert.equal(span.attributes['gen_ai.usage.input_tokens'], 125);
    assert.equal(span.attributes['gen_ai.usage.cache_read.input_tokens'], 100);
    assert.equal(span.attributes['gen_ai.usage.cache_creation.input_tokens'], 20);
  });

  it('a tool result sent back to Anthropic is the tool speaking, and the ask is still the user\'s words', () => {
    const request = {
      model: 'claude',
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '18C' }] },
      ],
    };
    const span = genAiSpan({ api: 'messages', request });
    const input = JSON.parse(String(span.attributes['gen_ai.input.messages']));
    assert.deepEqual(input.map((m: { role: string }) => m.role), ['user', 'assistant', 'tool']);
    assert.equal(span.attributes['iris.input'], 'Weather in Paris?');
  });

  it('a stream cut short keeps what arrived: the words, and a tool call\'s partial arguments', () => {
    const chat = assemblerFor('chat');
    chat.add({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'The capital' } }] });
    assert.equal(chat.result()?.choices[0].message.content, 'The capital');
    assert.equal(chat.result()?.choices[0].finish_reason, null);

    const anthropic = assemblerFor('messages');
    anthropic.add({ type: 'message_start', message: { id: 'm1', model: 'c', usage: { input_tokens: 3, output_tokens: 1 } } });
    anthropic.add({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'get_weather', input: {} } });
    anthropic.add({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city": "Pa' } });
    assert.equal(anthropic.result()?.content[0].input, '{"city": "Pa');

    const responses = assemblerFor('responses');
    responses.add({ type: 'response.created', response: { id: 'r', model: 'm', status: 'in_progress', output: [] } });
    responses.add({ type: 'response.output_text.delta', delta: 'Half an ans' });
    const span = genAiSpan({ api: 'responses', request: { model: 'm', input: 'q' }, response: responses.result() });
    assert.equal(span.attributes['iris.output'], 'Half an ans');
  });
});
