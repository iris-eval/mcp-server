# A CI gate with `iris-eval ingest`

`ingest` is the third door into Iris, after the MCP tools and `POST /api/v1/traces`, and the one that needs no server: a job pipes its traces in, Iris stores them, evaluates them under exactly the rules `evaluate_output` runs, prints one JSON line per trace, and can fail the job on a named verdict basis.

```bash
# one trace on stdin, evaluated, fail the job if a critical detector fired
echo '{"agent_name":"release-bot","input":"...","output":"...","tool_calls":[...],"cost_usd":0.04}' \
  | npx -y @iris-eval/mcp-server ingest --evaluate --fail-on detector_veto

# a batch (NDJSON, one trace per line) from a file
npx -y @iris-eval/mcp-server ingest --file traces.ndjson --evaluate --fail-on any
```

Each line printed is `{ "trace_id", "evaluation_id", "passed", "verdict": { "state", "basis", "by" }, "unjudged"?: [...], "spans"?: [{ "rule", "label", "source", "start", "end" }] }` and, when a verdict tripped the gate, `"tripped": "<basis>"`. Exit codes: **0** stored and nothing tripped · **1** at least one verdict tripped `--fail-on` · **2** usage error, or nothing was stored.

## `--fail-on`

| Value | Trips when |
|---|---|
| `detector_veto` | a critical detector fired — `no_pii`, `no_injection_patterns`, `no_blocklist_words` by default |
| `policy_gate` | a policy you configured failed (a threshold your config set, a custom rule at severity high or critical) |
| `critical_unknown` | a critical check was asked and could not answer |
| `required_evidence_missing` | `eval.requiredEvidence` named an input the trace did not carry |
| `risk_over_loss` | the risk estimate cleared your loss cut |
| `fail` | any failing verdict |
| `unknown` | any verdict that could not be reached — the fail-closed choice |
| `any` | anything but a clean pass |

## `--dataset` — gate only the cases the reader chose (0.15.0)

`--dataset <id|label>` restricts `--fail-on` to the case keys in a dataset. Every trace is still stored and evaluated; only a trace whose case key (supplied as `case_key`, or derived from `input`) is in the dataset can trip the gate. Each receipt gains `"gated": true|false`, and the summary line says how many of the evaluated traces were in the gate:

```
iris-eval ingest: 40 stored, 1 tripped --fail-on detector_veto (12 of 40 evaluated in dataset "release-gate")
```

Create the dataset once from a run's case keys — `POST /api/v1/datasets` with `{ "label": "release-gate", "from_run": "nightly-1" }` — or name the keys explicitly. `--dataset` needs `--fail-on` (it restricts the gate, nothing else); an unknown dataset is a usage error (exit 2) before any trace is read. The same dataset restricts `compare_runs` to the same cases.

## The walk-through — from a fresh install to a gate that names the leak (0.15.0)

Four steps, in the order the person who gates deploys does them; each prints one thing that proves it happened. The stranger harness runs this walk-through against the published package on every release (its gate phase, `tests/acceptance/stranger/run.mjs`, rows H-G1 to H-G4) and `tests/integration/deploy-gate-walkthrough.test.ts` runs it on every CI run.

1. **Start it where it will run, without a key, and read the refusal.** `IRIS_TRANSPORT=http IRIS_HOST=0.0.0.0 npx -y @iris-eval/mcp-server` — or, where a command cannot be prefixed with a variable (some agent sessions refuse it), the same through the strict config file: `npx -y @iris-eval/mcp-server --config gate.json` with `gate.json` reading `{ "transport": { "type": "http", "host": "0.0.0.0" } }` — (or `docker compose up` with `IRIS_API_KEY` unset) does not start: *"Refusing to bind the HTTP transport to 0.0.0.0 without an API key … Set IRIS_API_KEY (or --api-key, or IRIS_API_KEY_FILE), bind to 127.0.0.1 instead, or set IRIS_ALLOW_UNAUTHENTICATED=1 to run open on purpose."* The compose file refuses one step earlier (`IRIS_API_KEY=${IRIS_API_KEY:?…}`), before a container exists. Set the key and it starts.
2. **Say what evidence a verdict must rest on.** `eval.requiredEvidence: ["tool_calls"]` in the config: a trace that arrives without its tool calls is evaluated and its verdict is `unknown` with `basis: required_evidence_missing` — never `pass` on a trace that could not show what it did.
3. **Deploy the policy that gates.** `deploy_rule` (or `POST /api/v1/rules/custom`) with an `action_policy` rule at `severity: high` — for example, no tool named `delete_*` may be called. Over REST that body is `{ "name": "no-delete-tools", "evalType": "custom", "severity": "high", "definition": { "name": "no-delete-tools", "type": "action_policy", "config": { "deny": [{ "tool": "delete_*" }] } } }` — note `evalType` (the MCP tool spells the same field `eval_type`) and that each `deny` entry is an object, not a bare glob. A trace that calls one gets `basis: policy_gate`, `by: ["<your rule>"]`, and the rule's own message says it gates rather than advises.
4. **Gate the release cases, and read where the leak is.** Create the dataset once (`POST /api/v1/datasets` with `{ "label": "release-gate", "from_run": "…" }` or explicit case keys), then `iris-eval ingest --file traces.ndjson --evaluate --fail-on detector_veto --dataset release-gate`. A trace in the gate whose output carries a credential exits the job with 1; its receipt reads `"tripped": "detector_veto"`, `"verdict": { "by": ["no_pii"] }`, and `"spans": [{ "rule": "no_pii", "label": "AWS Access Key", "source": "output", "start": 45, "end": 65 }]` — the offsets and the label, never the secret. The stored evaluation (`iris://evaluations/{id}`, or `GET /api/v1/evaluations` filtered by trace) carries the same span; `--redact critical_spans` redacts the stored text, not the receipt's offsets.

## GitHub Actions — the action (0.16.0)

```yaml
- uses: iris-eval/mcp-server/.github/actions/gate@v0.16.0
  with:
    traces: traces.ndjson
```

That runs `iris-eval ingest --file traces.ndjson --evaluate --fail-on detector_veto`, fails the job when a verdict trips, writes the receipt to the job summary and, on a pull request, posts it as **one comment updated in place** on every run (found by a marker naming the traces file, so two gates in one workflow keep two comments). The job needs `permissions: pull-requests: write` for the comment; without it, or on a pull request from a fork (whose token is read-only), the receipt still reaches the summary and the action says the comment was skipped and why. A traces file that is empty fails the job: an unwritten file cannot pass as green.

| Input | Default | What it is |
|---|---|---|
| `traces` | — (required) | The traces file: NDJSON, or one JSON trace |
| `fail-on` | `detector_veto` | The basis that trips the gate — the table above |
| `dataset` | — | Restrict the gate to a dataset's case keys (id or label) that exists under `iris-home` |
| `eval-type` | every bundle | `completeness` · `relevance` · `safety` · `cost` · `custom` · `all` |
| `redact` | the server's default | `none` · `critical_spans` |
| `iris-home` | a scratch directory | Where the database lives; a cached directory keeps history across runs and holds the dataset |
| `version` | `latest` | The `@iris-eval/mcp-server` version `npx` runs |
| `command` | `npx -y @iris-eval/mcp-server@<version>` | Advanced: the command that runs `iris-eval` instead — `node dist/index.js` in a checkout of this repo |
| `comment` | `true` | On a pull request, the comment |
| `github-token` | `${{ github.token }}` | The token that posts it |

Outputs: `exit-code` (ingest's own: 0 · 1 · 2), `stored`, `evaluated`, `tripped`, `gated`, `summary-file`, and `comment` — `posted` · `updated` · `skipped-not-pr` · `skipped-fork` · `skipped-off` · `skipped-no-token` · `skipped-error`.

The receipt is the trace ids, the verdict bases, the rules that fired and the span labels — never the agent's text. To keep history across runs and compare them with `compare_runs` (pass `run` and `case_key` on each trace), cache `iris-home`:

```yaml
permissions:
  contents: read
  pull-requests: write
steps:
  - uses: actions/checkout@v4
  - uses: actions/cache@v4
    with:
      path: ${{ runner.temp }}/iris
      key: iris-${{ github.ref_name }}
  - uses: iris-eval/mcp-server/.github/actions/gate@v0.16.0
    with:
      traces: traces.ndjson
      fail-on: detector_veto
      dataset: release-gate
      iris-home: ${{ runner.temp }}/iris
```

The action is dogfooded on this repository's own CI (`gate-action` in `ci.yml`): the walk-through's three traces with the dataset seeded, one leak inside the gate caught and one outside ignored, a clean file passing, and the comment updated rather than duplicated on a second run.

Without the action, the same gate is one line:

```yaml
- name: Evaluate the agent's traces
  run: npx -y @iris-eval/mcp-server ingest --file traces.ndjson --evaluate --fail-on detector_veto
  env:
    IRIS_HOME: ${{ runner.temp }}/iris
```

The database lives under `IRIS_HOME` (`iris.db`); point it at a scratch directory in CI, or at a persistent one to keep history across runs.

## What it does not do

It never sweeps retention (the server does that once at start; a hook that swept on every turn would be a retention policy nobody set), it never proxies a key, and it never leaves the machine. It can run while a server holds the same database — SQLite's write-ahead log and the adapter's busy timeout make the two safe together, and the schema migrations take the write lock before they read, so two processes opening a fresh file at once both succeed.
