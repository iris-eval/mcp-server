# Capabilities — what Iris can judge, and what it cannot yet

Rendered from `capability-map.json` by `npm run llms:render`; do not edit `docs/capabilities.md` by hand. {{capabilitySummary}}

Ten evaluation questions against six subjects. **has** means at least one shipped, measured thing answers the question for that subject; **partial** means something answers it with a stated limit; **gap** means nothing does yet; **n/a** means the question does not apply to the subject. Every *has* or *partial* cell names its evidence — a rule, a tool, a resource, a route, a proof row or a judge template — and each name resolves to something registered in this release (`tests/capability-map-contract.test.ts`). *needs* lists the inputs a call must carry for the cell's rules to judge; without them those rules skip and the verdict's `coverage` says so. The same map is served to agents inside `iris://capabilities` and at https://iris-eval.com/capabilities.

{{capabilityMapTable}}
