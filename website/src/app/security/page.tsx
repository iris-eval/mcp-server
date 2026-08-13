import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { RATE_LIMIT_API, RATE_LIMIT_MCP } from "@/lib/claims";

export const metadata: Metadata = {
  title: "Security — Iris",
  description:
    "How Iris protects your data: local-by-default storage, tenant isolation, signed releases, SBOMs, and supply-chain transparency.",
  alternates: { canonical: "https://iris-eval.com/security" },
};

export default function Security(): React.ReactElement {
  return (
    <>
      <Nav />
      <article className="mx-auto max-w-3xl px-6 pb-20 pt-32 lg:pt-40">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-text-primary md:text-4xl">
          Security
        </h1>
        <p className="mt-2 text-[13px] text-text-muted">Last updated: April 23, 2026</p>

        <p className="mt-6 text-[15px] leading-relaxed text-text-secondary">
          Iris stores a lot of signal about your agents — inputs, outputs, tool
          calls, eval results. This page explains the concrete controls in
          place, the threat model we design against, and how to verify each
          claim for yourself.
        </p>

        <div className="mt-10 space-y-10 text-[15px] leading-relaxed text-text-secondary">
          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">
              Data location
            </h2>
            <p>
              <strong className="text-text-primary">Self-hosted (OSS):</strong>{" "}
              every trace, span, eval result, and audit entry is written to a
              SQLite database on your machine (default:{" "}
              <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                ~/.iris/iris.db
              </code>
              ). No data ever leaves your environment. Iris does not phone
              home. There is no telemetry.
            </p>
            <p className="mt-3">
              <strong className="text-text-primary">
                A hosted tier is under consideration, not under construction.
              </strong>{" "}
              No version is committed to it and no pricing exists. The
              cross-tenant isolation described below is already enforced at four
              independent layers in the self-hosted code — see the architecture
              guide for the technical detail — so <em>if</em> a hosted tier ever
              ships it inherits those boundaries rather than retrofitting them.
              Until it does, every control on this page describes software that
              runs on your machine.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">
              Tenant isolation
            </h2>
            <p>
              Every row in every data table carries a{" "}
              <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                tenant_id
              </code>{" "}
              column. Reads, writes, updates, and deletes require a tenant
              context parameter — there is no &ldquo;get all traces&rdquo;
              query path in the codebase. The four-layer defense:
            </p>
            <ol className="mt-3 list-decimal space-y-2 pl-6">
              <li>
                <strong className="text-text-primary">Type system.</strong>{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  TenantId
                </code>{" "}
                is a branded TypeScript type. Forgetting to pass tenant
                context is a compile error.
              </li>
              <li>
                <strong className="text-text-primary">Runtime guard.</strong>{" "}
                Every storage method calls{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  assertTenant()
                </code>{" "}
                which throws if the tenant is missing — even if the type
                checker was bypassed.
              </li>
              <li>
                <strong className="text-text-primary">SQL scope.</strong>{" "}
                Every SQL statement carries an explicit{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  WHERE tenant_id = ?
                </code>{" "}
                clause.
              </li>
              <li>
                <strong className="text-text-primary">Composite indexes.</strong>{" "}
                Every hot-path index leads with{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  tenant_id
                </code>{" "}
                so cross-tenant scans are physically impossible in the
                planner&rsquo;s fast path.
              </li>
            </ol>
            <p className="mt-3">
              Self-hosted Iris runs a single implicit tenant, so the boundary
              is scaffolding rather than a live multi-tenant surface today. The
              design rule it encodes: a tenant ID would be resolved server-side
              from an auth token&rsquo;s claims — never from a client-supplied
              query parameter or header. Regression coverage lives in{" "}
              <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                tests/unit/storage/sqlite-adapter.test.ts
              </code>{" "}
              (cross-tenant isolation) and{" "}
              <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                migration-tenant.test.ts
              </code>{" "}
              (upgrade path).
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">
              Supply-chain transparency
            </h2>
            <p>
              Every Iris release produces artifacts you can independently
              verify:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-6">
              <li>
                <strong className="text-text-primary">npm provenance.</strong>{" "}
                Every published tarball carries a GitHub-signed attestation
                linking it to the source commit and workflow run. Verify with{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  npm audit signatures
                </code>
                .
              </li>
              <li>
                <strong className="text-text-primary">SPDX SBOMs.</strong> A
                Software Bill of Materials ships with every release, covering
                direct and transitive dependencies for both the npm package
                and the Docker image. Attached to the GitHub release page as{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  iris-npm-sbom.spdx.json
                </code>{" "}
                and{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  iris-docker-sbom.spdx.json
                </code>
                .
              </li>
              <li>
                <strong className="text-text-primary">Cosign signatures.</strong>{" "}
                Docker images are signed with Sigstore cosign using GitHub
                OIDC (no long-lived signing key). Verify with:
                <pre className="mt-2 overflow-x-auto rounded bg-surface-elevated p-3 font-mono text-[12px] leading-relaxed text-text-primary">
                  {`cosign verify ghcr.io/iris-eval/mcp-server:vX.Y.Z \\
  --certificate-identity-regexp='https://github.com/iris-eval/mcp-server' \\
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com'`}
                </pre>
              </li>
              <li>
                <strong className="text-text-primary">
                  SLSA build provenance.
                </strong>{" "}
                Both artifacts carry GitHub-signed{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  attest-build-provenance
                </code>{" "}
                attestations. Inspect with{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  gh attestation verify
                </code>
                .
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">
              Runtime defenses
            </h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-text-primary">Helmet headers</strong> on
                the dashboard API (HSTS, X-Frame-Options, X-Content-Type-Options,
                strict CSP).
              </li>
              <li>
                <strong className="text-text-primary">Bearer-token auth</strong>{" "}
                on HTTP mode with{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  crypto.timingSafeEqual
                </code>
                -based comparison to block timing side-channels.
              </li>
              <li>
                <strong className="text-text-primary">Rate limiting:</strong>{" "}
                {RATE_LIMIT_MCP} req/min on MCP endpoints,{" "}
                {RATE_LIMIT_API} req/min on dashboard APIs, standard RateLimit
                headers.
              </li>
              <li>
                <strong className="text-text-primary">Zod input validation</strong>{" "}
                on every MCP tool and REST endpoint. Invalid requests fail
                fast with structured errors.
              </li>
              <li>
                <strong className="text-text-primary">ReDoS protection:</strong>{" "}
                every match of a user-supplied regex runs in a sandbox worker
                thread under a hard 100 ms deadline. A match still backtracking
                at the deadline is terminated mid-execution and the rule reports{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  skipped
                </code>{" "}
                with{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  budgetExceeded: true
                </code>
                ; a per-evaluation circuit breaker opens after 3 breaches, so
                one hostile request cannot stall the server no matter how many
                regex rules it carries.{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  safe-regex2
                </code>{" "}
                and the 1,000-character cap remain as fast-path rejection, not
                as the boundary — safe-regex2 is a star-height heuristic and{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  (a|a)*$
                </code>{" "}
                passes it.{" "}
                <strong className="text-text-primary">
                  The trade-off, stated plainly:
                </strong>{" "}
                this fails <em>open</em> per rule. A budget-killed rule did not
                judge the output, so an adversary who knows your pattern can
                craft input that stalls it into skipping. Failing closed would
                let the same adversary force false violations on benign output,
                which is worse for an eval product — so the{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  budgetExceeded
                </code>{" "}
                flag is exported precisely so a gate that must fail closed can
                treat those skips as failures on its own terms.
              </li>
              <li>
                <strong className="text-text-primary">Request size limit</strong>{" "}
                (1 MB default) to prevent memory-exhaustion attacks.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">
              Threat model
            </h2>
            <p>
              We maintain an internal STRIDE threat model covering ingestion,
              storage, dashboard API, auth, file I/O, and multi-tenant
              boundaries. The summary:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-6">
              <li>
                <strong className="text-text-primary">In scope:</strong> data
                confidentiality, tenant isolation, supply chain integrity, DoS
                resistance on the API surface, audit log tamper detection,
                prompt-injection-aware eval rules.
              </li>
              <li>
                <strong className="text-text-primary">Out of scope:</strong>{" "}
                physical access to the host machine (self-hosted), insider
                threats at the hosting provider, compromise of your LLM
                provider&rsquo;s infrastructure, social engineering of your
                developers.
              </li>
            </ul>
            <p className="mt-3">
              The full threat model is a private document reviewed and updated
              quarterly. We share redacted excerpts with enterprise customers
              under NDA on request.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">
              Reporting a vulnerability
            </h2>
            <p>
              If you believe you&rsquo;ve found a security issue, please email{" "}
              <a
                href="mailto:security@iris-eval.com"
                className="font-semibold text-text-accent hover:underline"
              >
                security@iris-eval.com
              </a>
              . Please do not open a public GitHub issue for security matters.
            </p>
            <p className="mt-3">
              We commit to:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-6">
              <li>Acknowledge your report within 2 business days.</li>
              <li>
                Provide a preliminary assessment (confirmed / not a
                vulnerability / need more info) within 7 days.
              </li>
              <li>
                Coordinate a disclosure timeline with you — we ask for 90 days
                by default, negotiable for high-severity or widely-exploited
                issues.
              </li>
              <li>
                Credit you in the release notes and the{" "}
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[13px]">
                  SECURITY.md
                </code>{" "}
                hall-of-thanks unless you prefer to remain anonymous.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">
              Compliance roadmap
            </h2>
            <p>
              Iris is pre-SOC-2 today. For enterprise buyers asking about
              compliance posture:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-6">
              <li>
                <strong className="text-text-primary">Today:</strong>{" "}
                security-by-design architecture, signed releases, SBOMs,
                internal STRIDE threat model.
              </li>
              <li>
                <strong className="text-text-primary">
                  If a hosted tier ever ships:
                </strong>{" "}
                formal SOC 2 Type I readiness, an independent penetration test
                and an incident-response playbook would come with it. A hosted
                tier is under consideration, not under construction — no version
                is committed to it.
              </li>
              <li>
                <strong className="text-text-primary">The commitment:</strong>{" "}
                no compliance certification will be claimed before it is held.
                Nothing on this page is a certification.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">
              Related reading
            </h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <Link
                  href="/privacy"
                  className="font-semibold text-text-accent hover:underline"
                >
                  Privacy Policy
                </Link>{" "}
                — what data we collect and how we use it.
              </li>
              <li>
                <Link
                  href="/terms"
                  className="font-semibold text-text-accent hover:underline"
                >
                  Terms of Use
                </Link>{" "}
                — licensing, acceptable use, warranties.
              </li>
              <li>
                <a
                  href="https://github.com/iris-eval/mcp-server/blob/main/docs/architecture.md"
                  className="font-semibold text-text-accent hover:underline"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Architecture Guide
                </a>{" "}
                — the full technical detail behind this page.
              </li>
            </ul>
          </section>
        </div>
      </article>
      <Footer />
    </>
  );
}
