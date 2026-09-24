# Webhooks — a message when a moment happens

Iris judges every trace it stores. A webhook is how it tells you when a judgement is worth a look: one signed `POST` to a URL you name, retried, cooled down per agent and rule, and never in the way of the evaluation that raised it. Slack, Discord and PagerDuty are webhooks; so is anything you write.

## Turn it on

`config.json` (`~/.iris/config.json`, or `IRIS_HOME`):

```json
{
  "notify": {
    "webhook": {
      "url": "https://hooks.example.com/iris",
      "secret": "whsec_…",
      "events": ["detector_veto", "regression_alarm", "flaky_case"],
      "cooldownMinutes": 10
    }
  }
}
```

Or from the environment, which merges over the file: `IRIS_WEBHOOK_URL`, `IRIS_WEBHOOK_SECRET`.

| Key | Required | Default | What it is |
|---|---|---|---|
| `url` | yes | — | An http(s) URL. The receiver. |
| `secret` / `secretFile` | for the `iris` format | — | The signing key: any string, or a `whsec_`-prefixed base64 secret the Standard Webhooks way. `secretFile` reads a file (trimmed) — the secret-file pattern for Docker and Kubernetes. One of the two, not both. |
| `events` | no | every event | Which of the five events to send (below). A name Iris does not send refuses startup naming it. |
| `cooldownMinutes` | no | `10` | The same event for the same agent and subject is sent once per window. `0` sends every one. |
| `format` | no | `iris` | `iris` (the signed JSON below), `slack` (`{ "text": … }` for a Slack incoming webhook), `discord` (`{ "content": … }` for a Discord webhook). The slack and discord formats may run unsigned: their URL is the credential. |
| `timeoutMs` | no | `10000` | One attempt's limit. |

The config file is strict: a misspelled key refuses startup naming the key it meant. `iris://capabilities` and `GET /api/v1/capabilities` report the webhook as `notify.webhook` — the events, the receiver's host, the format and whether deliveries are signed; never the URL's path (a Slack URL carries a token) and never the key.

The webhook is the server's. `iris-eval ingest` runs in its own process and posts nothing; the CI gate has its exit codes for that.

## The five events

| Event | When | The cooldown's subject |
|---|---|---|
| `verdict_fail` | The composed verdict failed, on any basis — the alert issue #5 asked for. | the rule that decided |
| `detector_veto` | A critical detection vetoed the verdict (`verdict.basis === "detector_veto"`): PII, an injection, an action policy. | the detector |
| `cost_anomaly` | The `cost_anomaly` rule fired: this trace's cost is an outlier against the agent's own last two hundred costed traces (modified z ≥ 3.5). | `cost_anomaly` |
| `regression_alarm` | The CUSUM watcher crossed its line at this evaluation for one rule: the fail rate has shifted against the baseline it settled on. It reports and never gates; the watcher resets and re-baselines. | the rule (and the run, when the stream is per run) |
| `flaky_case` | A case was answered both ways for the first time: every earlier attempt agreed and this one differs. Fires once per case, at the transition. | the case key |

One evaluation can be several events — a vetoed verdict is also a failed one — and each is its own delivery, so subscribe to what you want to act on. `detector_veto` and `regression_alarm` are the two worth a pager; `verdict_fail` on a busy agent is a feed, and the cooldown is what keeps it readable.

### How often `regression_alarm` fires when nothing has changed

Each rule an agent runs is watched as its own stream, so an agent with 25 rules has 25 chances to raise a false alarm on every evaluation. The watcher budgets false alarms **per agent**: when nothing has changed, an agent raises about one `regression_alarm` per 500 of its evaluations, however many rules it runs. Three things make that hold:

- **The budget is shared.** Each stream's alarm line is raised so that its own false-alarm rate is divided by the number of streams watched for the agent (one per rule, two per rule when traces carry a `run`); their sum stays at one per 500 (a Bonferroni bound). The line is found by simulation, not typed, and each alarm reports the number of streams it was set for.
- **The baseline has to be precise before watching starts.** A rule's stream is watched only once its baseline fail rate has at least ten expected fails behind it and a standard error of at most 2.5 percentage points — a quarter of the 10-point shift the watcher looks for. At a 20% fail rate that is about 260 evaluations; at 50%, about 400. A rule that never gets there is never watched.
- **The line allows for the baseline being off.** A baseline that came out a little low makes a steady stream look like drift. The line is set so that the false-alarm rate, averaged over what the true rate could be given that baseline, is on budget.

Measured on 40 simulated agents, each running 25 steady rules with fail rates from 2% to 30% over 5,000 evaluations: 1.5 false alarms per 1,000 evaluations per agent (it was 14.4 before the budget was per agent), and the median evaluation of an agent's first false alarm moved from 104 to 473. The cost is detection speed: for a rule failing 20% of the time on an agent with 25 rules, a rise to 30% is flagged after a median of about 210 evaluations. `tests/unit/eval/cusum.test.ts` re-runs the steady-agent case on fixed seeds and fails if the per-agent rate goes over budget.

## The delivery

```http
POST /iris HTTP/1.1
content-type: application/json
user-agent: iris-eval/0.16.0
webhook-id: msg_3f9c1a2b7d4e5f60718293a4
webhook-timestamp: 1790000000
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=
x-iris-signature: sha256=5b1f…
x-iris-event: detector_veto
```

```json
{
  "id": "msg_3f9c1a2b7d4e5f60718293a4",
  "type": "iris.detector_veto",
  "timestamp": "2026-09-21T12:00:00.000Z",
  "data": {
    "event": "detector_veto",
    "subject": "no_pii",
    "summary": "support-bot: a critical detection vetoed the verdict — no_pii.",
    "evaluation_id": "eval_…",
    "trace_id": "trace_…",
    "agent_name": "support-bot",
    "run_id": "nightly-42",
    "case_key": "refund-policy",
    "session_id": "conv-42",
    "evaluated_at": "2026-09-21T12:00:00.000Z",
    "verdict": { "state": "fail", "basis": "detector_veto", "by": ["no_pii"] },
    "score": 0.4,
    "failed_rules": ["no_pii"],
    "critical_failures": ["no_pii"],
    "detail": { "by": ["no_pii"], "critical_failures": ["no_pii"] }
  }
}
```

The body carries ids, the verdict, the rules and the numbers — **never the agent's input or output**. A receiver that wants the text reads the trace by id through `GET /api/v1/traces/:id`, with the same key as any other read; nothing leaves the box on the webhook that the dashboard's own redaction and retention do not govern. `detail` is the event's own numbers: the alarm (`p0`, `monitoredN`, `monitoredFails`, `h`, `statistic`), the anomaly (`cost_usd`, `modified_z`, `threshold`), the case's tally (`attempts`, `passed`, `runs`).

### Verify it

Two signatures, so any receiver verifies with what it already has:

- **Standard Webhooks** — `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`: HMAC-SHA256 with the secret over `id.timestamp.body`. A `standard-webhooks` library (Python, Node, Go, Ruby, Java, Rust, PHP, C#) verifies it as is, and checks the timestamp against its clock, which is what stops a replay. Iris allows five minutes of drift.
- **GitHub-style** — `x-iris-signature: sha256=<hex>`: HMAC-SHA256 with the secret over the raw body. One line to verify by hand.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, headers, rawBody) {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // a replay
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret);
  const expected = 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  return headers['webhook-signature'].split(' ').some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
```

Verify the **raw bytes** you received, before any JSON parsing re-serialises them.

### Retries, the cooldown, the queue

- One attempt and three retries — after 500 ms, 2 s and 8 s, each ±25% — on a network error, a timeout (`timeoutMs`), 408, 429 or any 5xx. Any other non-2xx answer is the receiver's final word and is not retried. Redirects are not followed.
- A delivery that fails every attempt is dropped with one log line (`Webhook dropped detector_veto for support-bot after 4 attempts: HTTP 503`) and a structured event (`webhook_dropped`); a delivered one logs `webhook_delivered` with the attempt count and the latency. Nothing is stored, nothing is replayed later: the webhook is a signal, and the dashboard is the record.
- The same `(event, agent, subject)` inside `cooldownMinutes` is one message. The window starts when the first is queued, so a delivery still retrying does not let a twin through.
- Deliveries run one at a time from a queue capped at a hundred; beyond that a moment is dropped with a log line rather than growing the process. An evaluation never waits for any of this — the moment is read after the evaluation row is written, off the caller's path.
- `webhook-id` is stable across the retries of one delivery: use it as the idempotency key. Delivery is at least once.

## Slack, Discord, PagerDuty

- **Slack** — an incoming webhook URL and `"format": "slack"`: the body is `{ "text": "*Iris — detector veto* (support-bot)\n…" }`.
- **Discord** — a channel webhook URL and `"format": "discord"`: `{ "content": … }`, cut at Discord's two thousand characters.
- **PagerDuty** — the Events API wants its own shape and a routing key, so point the `iris` format at a relay (a Cloudflare Worker, a Lambda, Zapier's catch hook) that verifies the signature and opens the incident. The payload above has everything a `dedup_key` wants (`data.evaluation_id`, or `data.subject` per agent).

## Where it is read from

Every door that stores an evaluation reaches the webhook — `evaluate_output`, `log_trace` with `evaluate`, `POST /api/v1/traces` with `evaluate`, the OTLP door with `otel.evaluateOnIngest`, a re-evaluation — because it is installed on the store, after the row is durable, and not in any one door. The demo server (`--demo`) never installs it: a week of backdated seeds is not a week of alerts.
