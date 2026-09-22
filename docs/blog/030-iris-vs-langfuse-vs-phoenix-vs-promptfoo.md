---
title: "Iris vs Langfuse vs Phoenix vs Promptfoo: where each wins, where each loses"
description: "Four ways to evaluate an AI agent, read from each vendor's own pages on 2026-09-21: how each gets into your stack, where the evaluation runs, what it costs to run, how it self-hosts, and what it does with MCP."
date: 2027-12-31
published: false
seoDescription: "Iris, Langfuse, Arize Phoenix and Promptfoo compared on integration, evaluation, cost to run, self-hosting and MCP — every vendor statement linked to the page it was read from."
author: Ian Parent
tags: [agent-eval, comparison, langfuse, phoenix, promptfoo, mcp]
devto_tags: [ai, agenteval, opensource, llm]
---

# Iris vs Langfuse vs Phoenix vs Promptfoo: where each wins, where each loses

> **Draft — not published.** The date in the front matter is a placeholder that keeps the site and the crossposter from publishing this until it is released. Every vendor statement below links the vendor's own page, read on 2026-09-21; the [compare pages](https://iris-eval.com/compare) carry the same cells with the sentence each was read from and whether that sentence was found on the page.

Four tools, four different answers to the same question: how do you know what an AI agent did, and whether it was any good? [Langfuse](https://langfuse.com/docs) is an open-source AI engineering platform, part of ClickHouse since January 2026 ([announcement](https://langfuse.com/blog/joining-clickhouse)). [Arize Phoenix](https://github.com/Arize-ai/phoenix) is the open-source half of Arize, whose acquisition by Dynatrace was announced in August 2026 ([announcement](https://arize.com/blog/a-new-chapter-with-dynatrace/)). [Promptfoo](https://www.promptfoo.dev/docs/intro/) is an open-source CLI for evaluating and red-teaming LLM apps, now part of OpenAI ([announcement](https://www.promptfoo.dev/blog/promptfoo-joining-openai/)). [Iris](https://iris-eval.com) is an MCP server that evaluates agent traces with deterministic rules and publishes each rule's precision and recall.

They are not four flavours of one thing. Two are observability platforms that added evaluation, one is a test runner, and one is an evaluation server that speaks the agent's own protocol. The differences that matter to a team choosing between them are the boring ones: how it gets into the stack, where the evaluation runs, what it costs, and what happens when the agent uses tools.

## How it gets into your stack

**Langfuse** is an SDK: its Python and JS SDKs wrap your functions with an `@observe` decorator, which "is an easy way to automatically capture inputs, outputs, timings, and errors of a wrapped function" ([Langfuse SDK docs](https://langfuse.com/docs/observability/sdk/python/decorators)). Beyond the SDKs it lists 100+ library and framework integrations and OpenTelemetry ([Langfuse docs](https://langfuse.com/docs)).

**Phoenix** is OpenTelemetry: you instrument the app with the OpenTelemetry SDK plus OpenInference auto-instrumentation, and export spans to the Phoenix collector ([Phoenix tracing docs](https://arize.com/docs/phoenix/tracing/llm-traces-1)). If your framework is already among its Python tracing integrations, that is a few lines ([Phoenix integrations](https://arize.com/docs/phoenix/integrations)).

**Promptfoo** is a test runner: declarative YAML test cases run from the CLI or a Node library, locally or as a CI step, calling the model providers directly ([Promptfoo intro](https://www.promptfoo.dev/docs/intro/)). Nothing is instrumented inside the app; the app is the thing under test.

**Iris** is one block in the MCP client's config. The agent connects, discovers Iris's tools, and logs traces or asks for verdicts through them; frameworks that are not MCP clients send OpenTelemetry traces to Iris's OTLP door instead ([clients](https://iris-eval.com/clients)).

## Where the evaluation runs

**Langfuse** evaluates with LLM-as-a-judge, human annotation, and custom scores through the API and SDK ([evaluation overview](https://langfuse.com/docs/evaluation/overview)); when "you want Langfuse to run deterministic Python or TypeScript logic for you, use code evaluators" ([custom scores](https://langfuse.com/docs/evaluation/evaluation-methods/custom-scores)). The judge calls are model calls you pay for.

**Phoenix** ships response and retrieval evals; the managed Arize AX adds LLM-as-a-judge, agent-as-a-judge and code evaluators ([Arize AX docs](https://arize.com/docs/ax)).

**Promptfoo** is the closest of the three to deterministic agent checks: its assertion library includes `trajectory:*` and tool-call assertions alongside model-graded rubrics and custom JavaScript or Python ([assertions reference](https://www.promptfoo.dev/docs/configuration/expected-outputs/)). The assertions run on your machine against the outputs the run produced.

**Iris** runs its built-in rules in-process, on the trace, with no model call — and publishes every rule's precision and recall on a labelled corpus at [iris-eval.com/proof](https://iris-eval.com/proof). Judge templates exist for the cases a rule cannot decide, on a key you supply. A rule you can read the accuracy of before you trust it is the design choice the other three do not make.

## What it costs to run

Prices are the vendors' own, read on 2026-09-21; the compare pages carry the sentence each was read from.

- **Langfuse** — Cloud: a free Hobby plan, Core at $29 a month, Pro at $199 a month, Enterprise at $2,499 a month; the MIT core is free to self-host ([Langfuse pricing](https://langfuse.com/pricing)).
- **Arize** — AX Free with 25k spans a month and 15-day retention, AX Pro at $50 a month, Enterprise custom; Phoenix itself is free to self-host ([Arize pricing](https://arize.com/pricing/)).
- **Promptfoo** — the Community edition is free forever, with red teaming capped at 10k probes a month; Enterprise by sales ([Promptfoo pricing](https://www.promptfoo.dev/pricing/)).
- **Iris** — free: MIT, one process on your machine. The single spend is a judge call on a key you supply, when you opt in ([Iris pricing](https://iris-eval.com/pricing)).

## Self-hosting

**Langfuse** self-hosts as web and worker containers backed by PostgreSQL, ClickHouse, Redis and S3 ([self-hosting](https://langfuse.com/self-hosting)). It is a real deployment.

**Phoenix** is `pip install arize-phoenix`; "by default Phoenix starts with a file-based SQLite database in a temporary folder", with PostgreSQL, Docker and Kubernetes as options ([configuration](https://arize.com/docs/phoenix/self-hosting/configuration)).

**Promptfoo** runs locally; a Docker image hosts a results server, and the vendor's own page says self-hosting "is not recommended for production use cases" ([self-hosting](https://www.promptfoo.dev/docs/usage/self-hosting/)).

**Iris** is one process and one SQLite file, or the Docker image with a health check ([README](https://github.com/iris-eval/mcp-server)).

## What each does with MCP

**Langfuse** offers a hosted MCP server that can create scores, evaluators and evaluation rules and query observations and datasets ([changelog](https://langfuse.com/changelog/2026-05-29-mcp-update)) — a way for a coding agent to drive Langfuse.

**Phoenix** ships an MCP server for prompts, traces, datasets, experiments and SQL; none of its tools runs an eval ([Phoenix MCP README](https://github.com/Arize-ai/phoenix/blob/main/js/packages/phoenix-mcp/README.md)).

**Promptfoo** goes the other way: its `mcp` provider "calls Model Context Protocol (MCP) tools directly, so you can test or red team the server itself" ([MCP provider](https://www.promptfoo.dev/docs/providers/mcp/)) — it tests MCP servers.

**Iris** is an MCP server. The agent discovers it on connect and logs and evaluates through its tools; Iris grades what the agent did with its tools, not whether a server honours its contract — a server test harness like Promptfoo's answers that question, and Iris runs beside it ([capabilities](https://iris-eval.com/capabilities)).

## Ownership and license

- **Langfuse**: "MIT licensed, except for the `ee` folders" ([repository](https://github.com/langfuse/langfuse)); part of ClickHouse since January 2026 ([announcement](https://langfuse.com/blog/joining-clickhouse)).
- **Phoenix**: Elastic License 2.0 ([license](https://github.com/Arize-ai/phoenix/blob/main/LICENSE)); Arize signed a definitive agreement to be acquired by Dynatrace in August 2026, close pending ([announcement](https://arize.com/blog/a-new-chapter-with-dynatrace/)).
- **Promptfoo**: the open-source core is MIT, Enterprise is commercial ([repository](https://github.com/promptfoo/promptfoo)); part of OpenAI ([announcement](https://www.promptfoo.dev/blog/promptfoo-joining-openai/)).
- **Iris**: MIT, the whole package, independent and founder-led ([repository](https://github.com/iris-eval/mcp-server)).

## Where each wins, where each loses

**Langfuse wins** when you need prompt management with versions and labels, broad framework coverage, and enterprise compliance on paper today (SOC 2, ISO 27001, HIPAA per its [security page](https://langfuse.com/security)). **It loses** on weight: the self-hosted footprint is five services ([self-hosting](https://langfuse.com/self-hosting)), and its evaluation is a judge or a human unless you write the code evaluator yourself.

**Phoenix wins** when your stack is already OpenTelemetry and you want an open-source tracing UI that starts with one `pip install` ([configuration](https://arize.com/docs/phoenix/self-hosting/configuration)). **It loses** for a team that wanted an evaluation product: the deeper evals and dashboards live in the managed AX tier ([Arize AX docs](https://arize.com/docs/ax)), and the license is ELv2 rather than MIT ([license](https://github.com/Arize-ai/phoenix/blob/main/LICENSE)).

**Promptfoo wins** for pre-deployment testing: YAML cases, deterministic and trajectory assertions, red-teaming plugins, all from the CLI in CI ([intro](https://www.promptfoo.dev/docs/intro/)). **It loses** as a production observer: nothing runs beside the live agent, and the vendor does not recommend self-hosting its server for production ([self-hosting](https://www.promptfoo.dev/docs/usage/self-hosting/)).

**Iris wins** when the agent speaks MCP and you want deterministic, local evaluation whose accuracy is published before you rely on it ([proof](https://iris-eval.com/proof)) — one config block, one process, one file. **It loses** when you need prompt management, a compliance certificate today, or a hundred framework integrations; those are not what it is, and the compare pages say so in muted cells rather than pretending otherwise ([compare](https://iris-eval.com/compare)).

## How to read this

Every vendor statement above was read from the linked page on the date given. The [compare pages](https://iris-eval.com/compare) carry the same cells with the sentence each was read from, the date, and whether a plain download of the page still carries that sentence; the file behind each page is in the [repository](https://github.com/iris-eval/mcp-server) under `website/src/lib/compare/`. If a vendor's page has changed, the cell is wrong, and the fix is a pull request.
