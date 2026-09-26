#!/usr/bin/env node
/*
 * A scripted model provider: the OpenAI Chat Completions, OpenAI Responses
 * and Anthropic Messages endpoints, answering from a fixed script so the
 * official SDKs can be driven against it with no key and the same result
 * every run.
 *
 *   node tests/fixtures/scripted-provider/server.mjs [--port N]
 *     prints {"port":N} on its first stdout line, then serves until killed.
 *
 *   import { startScriptedProvider } from './server.mjs';
 *   const provider = await startScriptedProvider();   // { url, port, requests, close() }
 *
 * The wire shapes are the providers' own — JSON, and Server-Sent Events
 * when the request says `stream: true` — because the clients that parse
 * them are the real SDKs: a shape they reject fails the test that uses it.
 *
 * The script, read from the request:
 *   the last user message mentions "provider error"  → 400, the provider's error body
 *   the last message is a tool result                → "It is 18 degrees and sunny in Paris."
 *   tools are offered and the ask mentions weather   → one call: get_weather {"city":"Paris"}
 *   the ask mentions an SSN                          → "Her SSN is 123-45-6789."
 *   anything else                                    → "The capital of France is Paris."
 * Usage: 10 input tokens per message in the request, plus 5 for a system
 * prompt; output tokens are the words in the reply (12 for a tool call).
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

export const REPLIES = {
  default: 'The capital of France is Paris.',
  ssn: 'Her SSN is 123-45-6789.',
  afterTool: 'It is 18 degrees and sunny in Paris.',
};
export const TOOL_CALL = { name: 'get_weather', arguments: { city: 'Paris' } };
const CREATED = 1_790_000_000;

/* ---------- reading the request ---------- */

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join(' ');
}

/** The messages as [{ role, text, toolResult }], whatever the API. */
function messagesOf(api, body) {
  if (api === 'responses') {
    if (typeof body.input === 'string') return [{ role: 'user', text: body.input, toolResult: false }];
    return (Array.isArray(body.input) ? body.input : []).map((item) => {
      if (item.type === 'function_call_output') return { role: 'tool', text: String(item.output ?? ''), toolResult: true };
      if (item.type === 'function_call') return { role: 'assistant', text: '', toolResult: false };
      return { role: item.role ?? 'user', text: textOf(item.content), toolResult: false };
    });
  }
  return (Array.isArray(body.messages) ? body.messages : []).map((m) => {
    if (m.role === 'tool') return { role: 'tool', text: textOf(m.content), toolResult: true };
    const blocks = Array.isArray(m.content) ? m.content : [];
    const toolResult = blocks.some((b) => b?.type === 'tool_result');
    return { role: m.role, text: textOf(m.content), toolResult };
  });
}

function hasSystem(api, body) {
  if (api === 'messages') return body.system !== undefined;
  if (api === 'responses') return typeof body.instructions === 'string';
  return (body.messages ?? []).some((m) => m.role === 'system' || m.role === 'developer');
}

/** What the script says to do with this request. */
export function decide(api, body) {
  const messages = messagesOf(api, body);
  const last = messages[messages.length - 1];
  const ask = [...messages].reverse().find((m) => m.role === 'user' && m.text)?.text ?? '';
  const inputTokens = 10 * messages.filter((m) => m.role !== 'system' && m.role !== 'developer').length + (hasSystem(api, body) ? 5 : 0);
  if (/provider error/i.test(ask) && !last?.toolResult) return { kind: 'error', status: 400, message: 'The scripted provider refused this request.' };
  if (last?.toolResult) return { kind: 'text', text: REPLIES.afterTool, inputTokens };
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length > 0 && /weather/i.test(ask)) return { kind: 'tool', inputTokens };
  if (/\bssn\b|social security/i.test(ask)) return { kind: 'text', text: REPLIES.ssn, inputTokens };
  return { kind: 'text', text: REPLIES.default, inputTokens };
}

const words = (text) => text.split(/\s+/).filter(Boolean).length;
const outputTokens = (d) => (d.kind === 'tool' ? 12 : words(d.text));
/** The reply in pieces, as a stream delivers it: word by word, spaces kept. */
const pieces = (text) => text.match(/\S+\s*/g) ?? [text];

/* ---------- OpenAI Chat Completions ---------- */

function chatBody(d, model, n) {
  const message =
    d.kind === 'tool'
      ? { role: 'assistant', content: null, refusal: null, tool_calls: [{ id: `call_${n}`, type: 'function', function: { name: TOOL_CALL.name, arguments: JSON.stringify(TOOL_CALL.arguments) } }] }
      : { role: 'assistant', content: d.text, refusal: null };
  return {
    id: `chatcmpl-scripted-${n}`,
    object: 'chat.completion',
    created: CREATED,
    model,
    system_fingerprint: 'fp_scripted',
    choices: [{ index: 0, message, logprobs: null, finish_reason: d.kind === 'tool' ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: d.inputTokens, completion_tokens: outputTokens(d), total_tokens: d.inputTokens + outputTokens(d), prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
  };
}

function* chatStream(d, model, n, includeUsage) {
  const base = { id: `chatcmpl-scripted-${n}`, object: 'chat.completion.chunk', created: CREATED, model, system_fingerprint: 'fp_scripted' };
  const chunk = (delta, finish = null) => ({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
  yield chunk({ role: 'assistant', content: '', refusal: null });
  if (d.kind === 'tool') {
    const args = JSON.stringify(TOOL_CALL.arguments);
    yield chunk({ tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: TOOL_CALL.name, arguments: '' } }] });
    yield chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 5) } }] });
    yield chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] });
    yield chunk({}, 'tool_calls');
  } else {
    for (const p of pieces(d.text)) yield chunk({ content: p });
    yield chunk({}, 'stop');
  }
  if (includeUsage) {
    yield { ...base, choices: [], usage: { prompt_tokens: d.inputTokens, completion_tokens: outputTokens(d), total_tokens: d.inputTokens + outputTokens(d) } };
  }
}

/* ---------- OpenAI Responses ---------- */

function responsesBody(d, model, n, status = 'completed') {
  const output =
    d.kind === 'tool'
      ? [{ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: TOOL_CALL.name, arguments: JSON.stringify(TOOL_CALL.arguments), status: 'completed' }]
      : [{ type: 'message', id: `msg_${n}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: d.text, annotations: [], logprobs: [] }] }];
  return {
    id: `resp_scripted_${n}`,
    object: 'response',
    created_at: CREATED,
    status,
    model,
    output: status === 'completed' ? output : [],
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    error: null,
    incomplete_details: null,
    usage:
      status === 'completed'
        ? { input_tokens: d.inputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: outputTokens(d), output_tokens_details: { reasoning_tokens: 0 }, total_tokens: d.inputTokens + outputTokens(d) }
        : null,
  };
}

function* responsesStream(d, model, n) {
  let seq = 0;
  const ev = (type, fields) => ({ type, sequence_number: seq++, ...fields });
  yield ev('response.created', { response: responsesBody(d, model, n, 'in_progress') });
  yield ev('response.in_progress', { response: responsesBody(d, model, n, 'in_progress') });
  const final = responsesBody(d, model, n);
  const item = final.output[0];
  if (d.kind === 'tool') {
    yield ev('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } });
    yield ev('response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta: item.arguments });
    yield ev('response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: item.arguments });
    yield ev('response.output_item.done', { output_index: 0, item });
  } else {
    yield ev('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    yield ev('response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
    for (const p of pieces(d.text)) yield ev('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: p, logprobs: [] });
    yield ev('response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text: d.text, logprobs: [] });
    yield ev('response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
    yield ev('response.output_item.done', { output_index: 0, item });
  }
  yield ev('response.completed', { response: final });
}

/* ---------- Anthropic Messages ---------- */

function messagesBody(d, model, n) {
  const content =
    d.kind === 'tool'
      ? [{ type: 'text', text: 'Let me check the weather.' }, { type: 'tool_use', id: `toolu_${n}`, name: TOOL_CALL.name, input: TOOL_CALL.arguments }]
      : [{ type: 'text', text: d.text }];
  return {
    id: `msg_scripted_${n}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: d.kind === 'tool' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: d.inputTokens, output_tokens: outputTokens(d), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

function* messagesStream(d, model, n) {
  const final = messagesBody(d, model, n);
  yield ['message_start', { type: 'message_start', message: { ...final, content: [], stop_reason: null, usage: { ...final.usage, output_tokens: 1 } } }];
  let index = 0;
  for (const block of final.content) {
    if (block.type === 'text') {
      yield ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }];
      for (const p of pieces(block.text)) yield ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: p } }];
    } else {
      yield ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }];
      const json = JSON.stringify(block.input);
      yield ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 4) } }];
      yield ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(4) } }];
    }
    yield ['content_block_stop', { type: 'content_block_stop', index }];
    index += 1;
  }
  yield ['message_delta', { type: 'message_delta', delta: { stop_reason: final.stop_reason, stop_sequence: null }, usage: { output_tokens: final.usage.output_tokens } }];
  yield ['message_stop', { type: 'message_stop' }];
}

/* ---------- the server ---------- */

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const e of events) res.write(e);
  res.end();
}

export async function startScriptedProvider({ port = 0, host = '127.0.0.1' } = {}) {
  /** Every request received, in order: { path, body, headers }. */
  const requests = [];
  let n = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      let body = {};
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'body is not JSON' } }));
        return;
      }
      // What the clients sent, for a test in another process to read.
      if (req.method === 'GET' && path === '/__requests') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(requests));
        return;
      }
      requests.push({ path, body, headers: req.headers });
      const api = path.endsWith('/chat/completions') ? 'chat' : path.endsWith('/responses') ? 'responses' : path.endsWith('/messages') ? 'messages' : null;
      if (req.method !== 'POST' || api === null) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `no scripted route for ${req.method} ${path}` } }));
        return;
      }
      n += 1;
      const d = decide(api, body);
      const model = typeof body.model === 'string' ? body.model : 'scripted-model';
      if (d.kind === 'error') {
        const error =
          api === 'messages'
            ? { type: 'error', error: { type: 'invalid_request_error', message: d.message } }
            : { error: { message: d.message, type: 'invalid_request_error', param: null, code: 'scripted_refusal' } };
        res.writeHead(d.status, { 'content-type': 'application/json', 'x-request-id': `req_${n}` }).end(JSON.stringify(error));
        return;
      }
      if (body.stream === true) {
        if (api === 'chat') {
          const events = [...chatStream(d, model, n, body.stream_options?.include_usage === true)].map((c) => `data: ${JSON.stringify(c)}\n\n`);
          sse(res, [...events, 'data: [DONE]\n\n']);
        } else if (api === 'responses') {
          sse(res, [...responsesStream(d, model, n)].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        } else {
          sse(res, [...messagesStream(d, model, n)].map(([name, e]) => `event: ${name}\ndata: ${JSON.stringify(e)}\n\n`));
        }
        return;
      }
      const json = api === 'chat' ? chatBody(d, model, n) : api === 'responses' ? responsesBody(d, model, n) : messagesBody(d, model, n);
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': `req_${n}` }).end(JSON.stringify(json));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const bound = server.address().port;
  return {
    port: bound,
    url: `http://${host}:${bound}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--port');
  const provider = await startScriptedProvider({ port: i > 0 ? Number(process.argv[i + 1]) : 0 });
  process.stdout.write(`${JSON.stringify({ port: provider.port })}\n`);
  const stop = () => provider.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
