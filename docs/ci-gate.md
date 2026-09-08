# A CI gate with `iris-eval ingest`

`ingest` is the third door into Iris, after the MCP tools and `POST /api/v1/traces`, and the one that needs no server: a job pipes its traces in, Iris stores them, evaluates them under exactly the rules `evaluate_output` runs, prints one JSON line per trace, and can fail the job on a named verdict basis.

```bash
# one trace on stdin, evaluated, fail the job if a critical detector fired
echo '{"agent_name":"release-bot","input":"...","output":"...","tool_calls":[...],"cost_usd":0.04}' \
  | npx -y @iris-eval/mcp-server ingest --evaluate --fail-on detector_veto

# a batch (NDJSON, one trace per line) from a file
npx -y @iris-eval/mcp-server ingest --file traces.ndjson --evaluate --fail-on any
```

Each line printed is `{ "trace_id", "evaluation_id", "passed", "verdict": { "state", "basis", "by" }, "unjudged"?: [...] }` and, when a verdict tripped the gate, `"tripped": "<basis>"`. Exit codes: **0** stored and nothing tripped · **1** at least one verdict tripped `--fail-on` · **2** usage error, or nothing was stored.

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

## GitHub Actions

```yaml
- name: Evaluate the agent's traces
  run: npx -y @iris-eval/mcp-server ingest --file traces.ndjson --evaluate --fail-on detector_veto
  env:
    IRIS_HOME: ${{ runner.temp }}/iris
```

The database lives under `IRIS_HOME` (`iris.db`); point it at a scratch directory in CI, or at a persistent one to keep history across runs and compare them with `compare_runs` (pass `run` and `case_key` on each trace).

## What it does not do

It never sweeps retention (the server does that once at start; a hook that swept on every turn would be a retention policy nobody set), it never proxies a key, and it never leaves the machine. It can run while a server holds the same database — SQLite's write-ahead log and the adapter's busy timeout make the two safe together, and the schema migrations take the write lock before they read, so two processes opening a fresh file at once both succeed.
