# @iris-eval/sdk

> **Not yet published to npm.** `@iris-eval/sdk` is built and proven in this repository's CI, but `npm install @iris-eval/sdk` does not resolve yet. To use it today, build it from source and install it by path:
>
> ```bash
> git clone https://github.com/iris-eval/mcp-server && cd mcp-server/packages/sdk
> npm ci && npm run build
> cd /path/to/your-project && npm install /path/to/mcp-server/packages/sdk
> ```

Record every model call your application makes and get [Iris](https://iris-eval.com)'s verdict on it, without the model having to call a tool and without changing the calls themselves.

```ts
import OpenAI from 'openai';
import { wrapOpenAI } from '@iris-eval/sdk';

const openai = wrapOpenAI(new OpenAI(), { agentName: 'support-bot' });
await openai.chat.completions.create({ model: 'gpt-5.2', messages });   // recorded, and scored by Iris
```

```ts
import Anthropic from '@anthropic-ai/sdk';
import { wrapAnthropic } from '@iris-eval/sdk';

const anthropic = wrapAnthropic(new Anthropic(), { agentName: 'support-bot' });
```

```ts
import { generateText, wrapLanguageModel } from 'ai';
import { irisMiddleware } from '@iris-eval/sdk';

const model = wrapLanguageModel({ model: yourModel, middleware: irisMiddleware({ agentName: 'support-bot' }) });
```

Each call becomes one standard OpenTelemetry GenAI span (`gen_ai.*`, the [semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)) sent to Iris's OTLP ingest, `POST /v1/traces`. Iris stores it as a trace with the input, the output, the token usage, the tool calls and the model, and scores it under the same rules `evaluate_output` runs. The Python client has the same pair: `wrap_openai` and `wrap_anthropic` in [`iris-eval`](../python/README.md).

## Where it sends

Start Iris with its dashboard (`npx -y @iris-eval/mcp-server --dashboard`). The recorder finds it the way the Python client does: `IRIS_URL`, else the port a running server wrote to `runtime.json` under `IRIS_HOME` (or `~/.iris`). A server started with a key needs `IRIS_API_KEY`. Or say it outright:

```ts
import { IrisRecorder, wrapOpenAI } from '@iris-eval/sdk';

const recorder = new IrisRecorder({ url: 'http://127.0.0.1:6920', apiKey: process.env.IRIS_API_KEY, onResult: (r) => console.log(r.trace_id, r.evaluation?.verdict?.state) });
const openai = wrapOpenAI(new OpenAI(), { recorder, agentName: 'support-bot', sessionId: conversationId });
// … at the end of a script or a test:
await recorder.flush();
recorder.results;   // what Iris stored for each call, with its verdict
```

## What is recorded

| API | Calls covered |
|---|---|
| OpenAI Chat Completions | `chat.completions.create` (plain and `stream: true`), `parse`, `stream`, `runTools`: every POST to `/chat/completions` |
| OpenAI Responses | `responses.create` (plain and `stream: true`), `stream`: every POST to `/responses` |
| Anthropic Messages | `messages.create` (plain and `stream: true`), `stream`: every POST to `/messages` |
| Vercel AI SDK | `generateText`, `streamText` and everything else that calls the wrapped model's `doGenerate` / `doStream`; each step of a tool loop is its own call |

The span carries `gen_ai.provider.name`, the request model and parameters, `gen_ai.response.id` / `model` / `finish_reasons`, `gen_ai.usage.input_tokens` / `output_tokens` (cached and reasoning tokens too, when the provider reports them), the tool catalogue as `gen_ai.tool.definitions`, and the conversation as `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.system_instructions`. Beside them, `iris.input` is the last thing the user asked and `iris.output` what the model answered, in words: the text Iris's rules read. A turn that only requests tools is recorded as those requests.

What is never recorded: the bytes of an image, audio or file part (the part is named by its type only). A text part longer than 16,384 characters is cut, and the cut says how many characters were left out.

## How it works, and what it will not do

- **The client is not patched.** Both official SDKs accept a `fetch` and clone themselves with `withOptions`; `wrapOpenAI(client)` returns `client.withOptions({ fetch })`, a real client of the same class. The original client is not changed, `withOptions` on the wrapped client stays wrapped, and wrapping twice is a no-op. Requests to any other endpoint pass straight through.
- **The call never waits on Iris.** A response is recorded after it has been read; a stream is passed on chunk for chunk as it arrives and recorded when it ends or is cancelled. `record()` puts the span on a bounded queue (1,000 traces; the oldest goes first) and returns; a timer sends it in the background and never keeps the process alive; a process that is done sends what is queued before it exits.
- **Errors are the provider's.** A refused call throws the SDK's own error, unchanged, and is recorded with `error.type` and the provider's message.
- **Iris being down is a normal state.** Nothing throws into your code; each kind of delivery failure is said once, on `console.warn`, or to your `onError`.
- **One change you can turn off.** OpenAI Chat Completions streams carry no token usage unless asked. When a streamed call does not set `stream_options`, the wrapper asks for usage and removes the usage-only final chunk before your code reads the stream, so the chunks you see are the ones you would have seen unwrapped. `wrapOpenAI(client, { streamUsage: false })` sends the request as written, for an OpenAI-compatible server that refuses the option.
- **A verdict is asked for per trace.** The recorder sets `iris.evaluate` on each trace's resource, so Iris scores these traces without `otel.evaluateOnIngest` scoring the rest of an OTLP feed. `{ evaluate: false }` stores without scoring; `{ evalType: 'safety' }` runs one bundle.

No runtime dependencies: the runtime's `fetch` and the OTLP wire format written by hand. ESM and CommonJS. Node 22 or later.

## Options

| Option | Where | Default |
|---|---|---|
| `recorder` | wrappers, middleware | one process-wide `IrisRecorder` |
| `agentName` | wrappers, middleware | the running program's name |
| `sessionId` | wrappers, middleware | none; sets `gen_ai.conversation.id`, which Iris reads as the session |
| `run` | wrappers, middleware | none; sets `iris.run`, for comparing runs |
| `evaluate`, `evalType` | wrappers, middleware, recorder | `true`, every bundle |
| `streamUsage` | `wrapOpenAI` | `true` |
| `url`, `apiKey` | recorder | `IRIS_URL` or `runtime.json`; `IRIS_API_KEY` |
| `maxQueue`, `flushIntervalMs`, `timeoutMs` | recorder | 1000, 250, 5000 |
| `onResult`, `onError` | recorder | none; one warning per kind of failure |

## Proven

CI (`sdk-js` in `.github/workflows/ci.yml`, Node 22 and 24) drives the official `openai` and `@anthropic-ai/sdk` clients, wrapped, against a scripted provider that answers in each API's own JSON and Server-Sent Events, and the `ai` package's `generateText` and `streamText` through `irisMiddleware`: a plain call, a stream, each SDK's stream helper, a tool call and its follow-up, and a refused call. Each call must arrive in a real Iris server built from the same commit as a trace with its input, output, token usage, span and verdict; an answer carrying an SSN must be failed. The same job packs the package, installs it into an empty project and loads it by `import` and by `require`. The mapping is held to the Python client's by a shared fixture, `tests/fixtures/genai-parity`.

## License

MIT
