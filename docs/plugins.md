# Plugin rules — a rule you wrote as code, loaded from a file you hash-pinned

The built-in roster is twenty-five rules in this package. Custom rules ([custom-rules.md](custom-rules.md)) are eight shapes deployed as JSON. A **plugin** is the third kind: an ES module you wrote, named in `config.json`, pinned by the sha256 of its file, and loaded at startup. It fires on every evaluation of its type exactly as a deployed custom rule does, its result is stamped like a built-in's, and `list_rules` names it under `plugins`.

## The contract

The module's default export (or a named export `plugin`) is:

```js
// ~/.iris/rules/no-competitor.mjs
export default {
  name: 'no_competitor_mention',          // lowercase snake_case, 2–64 chars; must not be a built-in's name
  kind: 'policy',                         // measurement | detection | inference | judgment | policy | verification
  mechanism: 'pattern',                   // formula | pattern | heuristic | model | external
  version: 1,                             // bump when the rule's meaning changes
  needs: ['output'],                      // output | input | expected | tool_calls | tool_outputs | tools_catalogue | cost | tokens | citations
  description: 'The output never names a competitor.',   // optional
  evalType: 'custom',                     // optional: completeness | relevance | safety | cost | custom (default custom)
  critical: false,                        // optional: a failing critical rule vetoes `passed`
  weight: 1,                              // optional
  evaluate(ctx) {                         // ctx: { output, input?, expected?, toolCalls?, spans?, tools?, costUsd?, tokenUsage?, ... }
    const hit = /\b(acme|globex)\b/i.exec(ctx.output);
    return hit
      ? { ruleName: 'no_competitor_mention', passed: false, score: 0, message: `names ${hit[0]}`, evidence: [{ type: 'span', source: 'output', start: hit.index, end: hit.index + hit[0].length, text: hit[0] }] }
      : { ruleName: 'no_competitor_mention', passed: true, score: 1, message: 'no competitor named' };
  },
};
```

`evaluate` returns the same shape a built-in returns: `passed` (boolean), `score` (0–1), `message` (string), and optionally `evidence`, `skipped` with `skipReason`. It is synchronous — the engine keeps every deterministic rule synchronous on purpose, so a rule cannot reach the network by construction.

## Naming it

```bash
openssl dgst -sha256 ~/.iris/rules/no-competitor.mjs     # or: shasum -a 256
```

```json
{ "eval": { "plugins": [{ "path": "./rules/no-competitor.mjs", "sha256": "<the 64 hex characters>" }] } }
```

Relative paths resolve against the Iris home (`~/.iris`, or `IRIS_HOME`), where `config.json` lives. The server, `--demo` and `iris-eval ingest` all load the same list, so the three doors cannot disagree about which rules run.

## What refuses startup

A plugin runs in-process with the server's privileges — that is the point of the hash. Each of these stops the process before any port is bound, with one sentence naming the path and the problem:

- the file cannot be read;
- the file's sha256 is not the pinned one (the sentence shows both — re-pin on purpose, or restore the file);
- the module cannot be imported, or its default export lacks the contract (the sentence names the field);
- the name is a built-in rule's, or another plugin's.

`iris-eval ingest` answers the same sentence on stderr and exits 2 before reading any trace.

## What a loaded plugin does

- Fires on every evaluation of its `evalType`, alongside the built-ins and the deployed custom rules.
- Its result carries `origin: "plugin"`, `kind`, `mechanism`, `ruleVersion` and an `uncertainty` stamped by kind: `policy` for a policy rule; for a detection or inference, `unmeasured` until the deployment's own labels measure it — twenty labels on its fires give it a local precision like any other rule ([how that is measured](https://iris-eval.com/proof)).
- `critical: true` makes a failing plugin veto `passed` (the `policy_gate` basis, as a high-severity custom rule does); without it the failure is reported and scored but does not gate.
- A plugin that throws, or returns a result without a boolean `passed`, a score outside 0–1 or a `message`, **skips that evaluation** as `config_invalid` naming itself. The server never goes down for a rule.
- `list_rules` lists it under `plugins` with its metadata, its path and its pinned hash — never its code.

## What it is not

Not sandboxed: a plugin is your code, running as the server. Pin what you have read. Not hot-reloaded: a changed file needs a re-pin and a restart, and a changed file without a re-pin refuses the restart — which is the guarantee.
