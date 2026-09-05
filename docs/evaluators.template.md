# Evaluator of evaluators — the thirteen trust questions, asked of every evaluator Iris ships

Rendered from `.claims.json → evaluators` by `npm run llms:render`; do not edit `docs/evaluators.md` by hand. {{evaluatorsSummary}}

Every cell is derived from the committed proof files by `scripts/claims/generators/evaluators.mjs` — never typed. A cell reads **measured** only when a number for it exists in `proof/results.json`, `proof/composite-results.json` or `proof/judge-results.json`, and the evidence list below names the file and key. The other statuses: **partial** (part of the question has a number — the misses are named by id, but no rate), **stated** (the answer is a declaration in code or a corpus definition, not a measurement), **measurable** (the harness that would measure it is named; no number yet), **n/a** (the question does not apply — a deterministic rule has no prompt or model sensitivity). The judge templates and the citation verifier stay measurable until a judge key that the founder or a user supplies runs `npm run proof:judge`; every other row moves only when a release roll regenerates the proof files.

{{evaluatorsMatrixTable}}
