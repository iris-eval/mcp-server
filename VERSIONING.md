# Versioning and release policy

Iris follows [Semantic Versioning 2.0.0](https://semver.org/). This page states
how that maps onto a pre-1.0 project, what each number promises, and when 1.0
will be declared — so a reader can predict what an upgrade will do to them
before they run it.

## While the version starts with `0.`

Semver gives a 0.x project one lever for compatibility: the **minor**.

| Change                                                                                                                                   | Bump                          | Example from this project                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| Anything an existing caller can observe changing — a default, a response field, an accepted argument, a rule that starts or stops firing | **minor** (`0.7.0` → `0.8.0`) | `evaluate_output` began running every bundle when `eval_type` is omitted |
| New capability that leaves existing behaviour alone                                                                                      | **minor**                     | the trajectory rules, which skip unless tool calls are supplied          |
| Fixes, documentation, dependency bumps, anything a caller cannot observe as a change in contract                                         | **patch** (`0.8.0` → `0.8.1`) | a false positive removed from a rule's pattern list                      |

Every change of the first kind is written in `CHANGELOG.md` as a bold
**Behaviour change:** sentence naming what breaks and what the caller does
about it. If a release has one of those sentences, it is a minor. The reverse
holds too: a minor release without one is a release that added capability.

**We have not always been consistent about this.** `0.5.1` shipped two
behaviour-change sentences and was numbered as a patch. That was our error, not
a different policy, and this page exists so it does not repeat.

## Release cadence

Releases are cut when a body of work is complete and has passed its acceptance
pass — not on a calendar, and not per merged pull request. Several minors in a
short window is a signal that work is being released in pieces that belonged
together; the fix is to batch, not to renumber.

Every release is cut by the same path: a version-roll pull request through the
full check set, a tag, and a workflow that publishes to npm, the container
registry, the GitHub release page and the Official MCP Registry, then verifies
each of those from outside before it reports success.

## What 1.0 will mean, and what has to be true first

At 1.0 the compatibility lever moves to the **major**, and a breaking change
becomes a rare, deliberate, well-announced event rather than a minor bump. We
will declare 1.0 when all of the following hold, and we will say so here on the
day it does:

1. **The response shape is settled.** No planned work changes the fields of an
   `evaluate_output` result or the shape of a rule result.
2. **The rule roster is settled.** Adding a rule is additive; changing what an
   existing rule means is not, and we expect a few more of those.
3. **The published accuracy has external validation.** The corpus behind
   [/proof](https://iris-eval.com/proof) is currently written and labelled by a
   language model, disclosed as such; human agreement on a sample is the
   upgrade that makes the numbers something to build a gate on.
4. **Two consecutive releases carry no behaviour-change sentence.** The
   simplest evidence that the surface has stopped moving is that it stopped
   moving.

Until then the version stays below 1.0, which is the honest signal: the product
is usable and measured, and its contract can still move with a minor bump.

## Deprecation

Once at 1.0, anything removed gets one minor release of deprecation first: it
keeps working, it warns, the changelog says what replaces it, and the removal
lands in the next major. Before 1.0 we do the same wherever it costs little,
but the minor bump is the only guarantee.
