---
title: "Iris vs Langfuse vs Phoenix vs Promptfoo: where each wins, where each loses"
description: "Four ways to evaluate an AI agent, read from each vendor's own pages on 2026-10-01: how each gets into your stack, where the evaluation runs, what it costs to run, how it self-hosts, and what it does with MCP."
date: 2026-10-01
published: true
seoDescription: "Iris, Langfuse, Arize Phoenix and Promptfoo compared on integration, evaluation, cost to run, self-hosting and MCP — every vendor statement linked to the page it was read from."
author: Ian Parent
tags: [agent-eval, comparison, langfuse, phoenix, promptfoo, mcp]
devto_tags: [ai, agenteval, opensource, llm]
---

# Iris vs Langfuse vs Phoenix vs Promptfoo: where each wins, where each loses

Four tools, four different answers to the same question: how do you know what an AI agent did, and whether it was any good? [Langfuse](https://langfuse.com/docs) is an open-source AI engineering platform, part of ClickHouse since January 2026 ([announcement](https://langfuse.com/blog/joining-clickhouse)). [Arize Phoenix](https://github.com/Arize-ai/phoenix) is the open-source half of Arize, whose acquisition by Dynatrace was announced in August 2026 ([announcement](https://arize.com/blog/a-new-chapter-with-dynatrace/)). [Promptfoo](https://www.promptfoo.dev/docs/intro/) is an open-source CLI for evaluating and red-teaming LLM apps, now part of OpenAI ([repository](https://github.com/promptfoo/promptfoo)). [Iris](https://iris-eval.com) is an MCP server that evaluates agent traces with deterministic rules and publishes each rule's precision and recall.

They are not four flavours of one thing. Two are observability platforms that added evaluation, one is a test runner, and one is an evaluation server that speaks the agent's own protocol. The differences that matter to a team choosing between them are the boring ones: how it gets into the stack, where the evaluation runs, what it costs, and what happens when the agent uses tools.

Every vendor statement below links the vendor's own page, read on 2026-10-01; the [compare pages](https://iris-eval.com/compare) carry the same cells with the sentence each was read from and whether that sentence was found on the page.

## How it gets into your stack

**Langfuse** is an SDK: its Python and JS SDKs wrap your functions with an `observe` decorator or wrapper, which "is an easy way to automatically capture inputs, outputs, timings, and errors of a wrapped function" ([Langfuse SDK docs](https://langfuse.com/docs/observability/sdk/instrumentation)). Beyond the SDKs it lists 100+ library and framework integrations and OpenTelemetry ([Langfuse docs](https://langfuse.com/docs)).

**Phoenix** is OpenTelemetry: you instrument the app with the OpenTelemetry SDK plus OpenInference auto-instrumentation, and export spans to the Phoenix collector ([Phoenix tracing docs](https://arize.com/docs/phoenix/get-started/get-started-tracing)). If your framework is already among its tracing integrations, that is a few lines ([Phoenix integrations](https://arize.com/docs/phoenix/integrations)).

**Promptfoo** is a test runner: declarative test cases run from the CLI or as a library, locally or as a CI step, calling the model providers directly ([Promptfoo intro](https://www.promptfoo.dev/docs/intro/)). Output assertions need nothing inside the app; its trajectory assertions read OpenTelemetry spans the app sends to Promptfoo ([tracing](https://www.promptfoo.dev/docs/tracing/)).

**Iris** is one block in the MCP client's config. The agent connects, discovers Iris's tools, and logs traces or asks for verdicts through them; frameworks that are not MCP clients send OpenTelemetry traces to Iris's OTLP door instead ([clients](https://iris-eval.com/clients)).

## Where the evaluation runs

**Langfuse** evaluates with LLM-as-a-judge, Jev as a judge (a decision model that "does not sample text, so the same state and question return the same verdict"), human annotation, and custom scores through the API and SDK ([evaluation overview](https://langfuse.com/docs/evaluation/overview), [Jev as a judge](https://langfuse.com/docs/evaluation/evaluation-methods/jev-as-a-judge)); when "you want Langfuse to run deterministic Python or TypeScript logic for you, use code evaluators" ([scores via API/SDK](https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk)). LLM-as-a-judge calls are model calls you pay for.

**Phoenix** runs evaluators on the server: "LLM-as-a-judge evaluators backed by Phoenix-managed prompts", and code evaluators whose local backends ship with Phoenix, so they run on a self-hosted deployment ([server evals](https://arize.com/docs/phoenix/evaluation/server-evals), [code evaluators](https://arize.com/docs/phoenix/evaluation/server-evals/code-evaluators)). The managed Arize AX adds agent-as-a-judge ([Arize AX docs](https://arize.com/docs/ax)).

**Promptfoo** goes furthest into the agent's trajectory: its assertion library includes `trajectory:*` and tool-call assertions alongside model-graded rubrics and custom JavaScript or Python ([assertions reference](https://www.promptfoo.dev/docs/configuration/expected-outputs/)). The assertions run on your machine against what the run produced.

**Iris** runs its built-in rules in-process, on the trace, with no model call, and publishes every built-in rule's precision and recall on a labelled corpus at [iris-eval.com/proof](https://iris-eval.com/proof), regenerated from the code at each release. Judge templates exist for the cases a rule cannot decide, on a key you supply.

## What it costs to run

Prices are the vendors' own, read on 2026-10-01; the compare pages carry the sentence each was read from.

- **Langfuse** — Cloud: a free Hobby plan, Core at $29 a month, Pro at $199 a month, Enterprise at $2,499 a month; the MIT core is free to self-host ([Langfuse pricing](https://langfuse.com/pricing)).
- **Arize** — AX Free with 25k spans a month and 15-day retention, AX Pro at $50 a month, Enterprise custom; Phoenix is "our open-source, local-first platform" ([Arize pricing](https://arize.com/pricing/)).
- **Promptfoo** — the Community edition is free forever, with red teaming capped at 10k probes a month; Enterprise and On-Premise by sales ([Promptfoo pricing](https://www.promptfoo.dev/pricing/)).
- **Iris** — free: MIT, one process on your machine. The single spend is a judge call on a key you supply, when you opt in ([Iris pricing](https://iris-eval.com/pricing)).

## Self-hosting

**Langfuse** self-hosts as web and worker containers backed by PostgreSQL, ClickHouse, Redis or Valkey, and S3 or blob storage ([self-hosting](https://langfuse.com/self-hosting)). It is a real deployment.

**Phoenix** is `pip install arize-phoenix` and `phoenix serve` ([terminal](https://arize.com/docs/phoenix/self-hosting/deployment-options/terminal)); "by default Phoenix starts with a file-based SQLite database in a temporary folder", with PostgreSQL as the other database ([configuration](https://arize.com/docs/phoenix/self-hosting/configuration)), and Docker and Kubernetes among its deployment options.

**Promptfoo** runs locally; a Docker image hosts a results server, and the vendor's own page says self-hosting "is not recommended for production use cases" ([self-hosting](https://www.promptfoo.dev/docs/usage/self-hosting/)).

**Iris** is one process and one SQLite file, or the Docker image with a health check ([README](https://github.com/iris-eval/mcp-server)).

## What each does with MCP

**Langfuse** offers a hosted MCP server that can query observations, metrics and datasets and create scores ([changelog](https://langfuse.com/changelog/2026-05-29-mcp-update)), and create evaluators and evaluation rules ([changelog](https://langfuse.com/changelog/2026-06-10-evaluators-via-mcp)) — a way for a coding agent to drive Langfuse.

**Phoenix** builds a remote MCP server into Phoenix 19 and later. "The operation catalog is generated from the Phoenix REST API", so an agent can work with projects, traces, datasets, experiments, prompts and annotations ([remote MCP](https://arize.com/docs/phoenix/integrations/remote-mcp)), including SQL over traces ([Arize blog](https://arize.com/blog/phoenix-mcp-sql-code-mode/)) — again, a way for a coding agent to drive Phoenix.

**Promptfoo** goes the other way: its `mcp` provider "calls Model Context Protocol (MCP) tools directly, so you can test or red team the server itself" ([MCP provider](https://www.promptfoo.dev/docs/providers/mcp/)) — it tests MCP servers.

**Iris** is an MCP server. The agent discovers it on connect and logs and evaluates through its tools; Iris grades what the agent did with its tools, not whether a server honours its contract — a server test harness like Promptfoo's answers that question, and Iris runs beside it ([capabilities](https://iris-eval.com/capabilities)).

## Ownership and license

- **Langfuse**: "MIT licensed, except for the `ee` folders" ([repository](https://github.com/langfuse/langfuse)); part of ClickHouse since January 2026 ([announcement](https://langfuse.com/blog/joining-clickhouse)).
- **Phoenix**: Elastic License 2.0 ([license](https://github.com/Arize-ai/phoenix/blob/main/LICENSE)); Arize signed a definitive agreement to be acquired by Dynatrace in August 2026, not yet closed on 2026-10-01 ([announcement](https://arize.com/blog/a-new-chapter-with-dynatrace/)).
- **Promptfoo**: MIT ([repository](https://github.com/promptfoo/promptfoo)), with commercial Enterprise and On-Premise editions ([pricing](https://www.promptfoo.dev/pricing/)); "now part of OpenAI", and "remains open source and MIT licensed" ([repository](https://github.com/promptfoo/promptfoo)).
- **Iris**: MIT, the whole package, independent and founder-led ([repository](https://github.com/iris-eval/mcp-server)).

## Where each wins, where each loses

**Langfuse wins** when you need prompt management with versions and labels ([prompt management](https://langfuse.com/docs/prompt-management/overview)), broad framework coverage, and enterprise compliance on paper today (SOC 2, ISO 27001, HIPAA per its [security page](https://langfuse.com/security)). **It loses** on weight: self-hosting means two application containers and four datastores ([self-hosting](https://langfuse.com/self-hosting)).

**Phoenix wins** when your stack is already OpenTelemetry and you want an open-source tracing and evaluation UI that starts with one `pip install` ([terminal](https://arize.com/docs/phoenix/self-hosting/deployment-options/terminal)). **It loses** for a team that needs an OSI-approved license: Phoenix is ELv2 rather than MIT ([license](https://github.com/Arize-ai/phoenix/blob/main/LICENSE)), and agent-as-a-judge lives in the managed AX tier ([Arize AX docs](https://arize.com/docs/ax)).

**Promptfoo wins** for pre-deployment testing: declarative cases, deterministic and trajectory assertions, red-teaming plugins, all from the CLI in CI ([intro](https://www.promptfoo.dev/docs/intro/)). **It loses** as an open-source production observer: the open-source tool tests before deployment, runtime protection is a separate commercial product ([Guardrails](https://www.promptfoo.dev/guardrails/)), and the vendor does not recommend self-hosting its results server for production ([self-hosting](https://www.promptfoo.dev/docs/usage/self-hosting/)).

**Iris wins** when the agent speaks MCP and you want deterministic, local evaluation whose accuracy is published before you rely on it ([proof](https://iris-eval.com/proof)) — one config block, one process, one file. **It loses** when you need prompt management, a compliance certificate today, or a hundred framework integrations; those are not what it is, and the compare pages say so in muted cells rather than pretending otherwise ([compare](https://iris-eval.com/compare)).

## How to read this

Every vendor statement above was read from the linked page on 2026-10-01. The [compare pages](https://iris-eval.com/compare) carry the same cells with the sentence each was read from, the date, and whether a plain download of the page still carries that sentence; the file behind each page is in the [repository](https://github.com/iris-eval/mcp-server) under `website/src/lib/compare/`. If a vendor's page has changed, the cell is wrong, and the fix is a pull request.
