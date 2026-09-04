import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import {
  CUSTOM_REGEX_MAX_LENGTH,
  DISCLOSURE_ACK_HOURS,
  DISCLOSURE_RESPONSE_BUSINESS_DAYS,
  DISCLOSURE_WINDOW_DAYS,
  MAINTENANCE,
  PUBLIC_REPO_URL,
  RATE_LIMIT_API,
  RATE_LIMIT_MCP,
  REGEX_BREACHES_PER_EVALUATION,
  REGEX_MATCH_BUDGET_MS,
  REQUEST_SIZE_LIMIT,
  SECURITY_EMAIL,
} from "@/lib/claims";
import { OG_IMAGE_URL } from "@/lib/og";
import { PAGE_LAST_MODIFIED } from "@/lib/page-dates";

/*
 * The page's own file may be older than the data it renders: the fix-latency block is sampled
 * when the truthbase is generated, which is later than the last edit to this file more often
 * than not. Showing the file's date made the header claim the page was last updated the day
 * before the figures it displays were sampled (found by the v0.7.0 acceptance pass), so the
 * header takes whichever is later.
 */
const lastUpdated: string = [
  PAGE_LAST_MODIFIED["/security"],
  String(MAINTENANCE.sampledAt).slice(0, 10),
].sort()[1];

export const metadata: Metadata = {
  title: "Security — Iris",
  description:
    "How Iris protects your data: local-by-default storage, tenant isolation, signed releases, SBOMs, supply-chain transparency, one disclosure policy, and measured issue-close times.",
  alternates: { canonical: "https://iris-eval.com/security" },
  openGraph: {
    title: "Security — Iris",
    description:
      "Local-by-default storage, tenant isolation, signed releases, SBOMs, supply-chain transparency, and measured issue-close times.",
    url: "https://iris-eval.com/security",
    type: "website",
    images: [OG_IMAGE_URL],
  },
  twitter: {
    card: "summary_large_image",
    title: "Security — Iris",
    description:
      "Local-by-default storage, tenant isolation, signed releases, SBOMs, supply-chain transparency, and measured issue-close times.",
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

const code = "rounded bg-bg-surface px-1.5 py-0.5 font-mono text-[13px] text-text-primary";

// "1mb" (the express.json limit string) → "1 MB"; anything else verbatim.
function humanSize(limit: string): string {
  const m = limit.match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb)$/i);
  return m ? `${m[1]} ${m[2].toUpperCase()}` : limit;
}

// ISO date (UTC) → "September 3, 2026". Dates here are calendar facts, not
// moments, so they are pinned to UTC to render the same on every machine.
function longDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

function hoursAndDays(hours: number | null): string {
  if (hours === null) return "no closed issues in the window";
  const days = hours / 24;
  return `${hours.toFixed(1)} h (${days.toFixed(1)} d)`;
}

export default function Security(): React.ReactElement {
  const m = MAINTENANCE;
  const closedIssuesUrl = `${PUBLIC_REPO_URL}/issues?q=is%3Aissue+is%3Aclosed+sort%3Aupdated-desc`;
  const openIssuesUrl = `${PUBLIC_REPO_URL}/issues?q=is%3Aissue+is%3Aopen`;
  const smallSample = m.issues.closedInWindow < 20;

  return (
    <>
      <Nav />
      <article className="mx-auto max-w-3xl px-6 pb-20 pt-32 lg:pt-40">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-balance text-text-primary md:text-4xl">
          Security
        </h1>
        <p className="mt-2 text-[13px] text-text-muted">
          Last updated: {longDate(lastUpdated)}
        </p>

        <p className="mt-6 text-[15px] leading-relaxed text-text-secondary">
          Iris stores a lot of signal about your agents — inputs, outputs, tool
          calls, eval results. This page explains the concrete controls in
          place, the threat model we design against, and how to verify each
          claim for yourself. Every number on it is either read from the
          shipped source when the page is built or measured from a public
          record, and each section says which.
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
              <code className={code}>~/.iris/iris.db</code>
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
              <code className={code}>tenant_id</code> column. Reads, writes,
              updates, and deletes require a tenant context parameter — there
              is no &ldquo;get all traces&rdquo; query path in the codebase.
              The four-layer defense:
            </p>
            <ol className="mt-3 list-decimal space-y-2 pl-6">
              <li>
                <strong className="text-text-primary">Type system.</strong>{" "}
                <code className={code}>TenantId</code> is a branded TypeScript
                type. Forgetting to pass tenant context is a compile error.
              </li>
              <li>
                <strong className="text-text-primary">Runtime guard.</strong>{" "}
                Every storage method calls{" "}
                <code className={code}>assertTenant()</code> which throws if
                the tenant is missing — even if the type checker was bypassed.
              </li>
              <li>
                <strong className="text-text-primary">SQL scope.</strong>{" "}
                Every SQL statement carries an explicit{" "}
                <code className={code}>WHERE tenant_id = ?</code> clause.
              </li>
              <li>
                <strong className="text-text-primary">Composite indexes.</strong>{" "}
                Every hot-path index leads with{" "}
                <code className={code}>tenant_id</code> so cross-tenant scans
                are physically impossible in the planner&rsquo;s fast path.
              </li>
            </ol>
            <p className="mt-3">
              Self-hosted Iris runs a single implicit tenant, so the boundary
              is scaffolding rather than a live multi-tenant surface today. The
              design rule it encodes: a tenant ID would be resolved server-side
              from an auth token&rsquo;s claims — never from a client-supplied
              query parameter or header. Regression coverage lives in{" "}
              <code className={code}>tests/unit/storage/sqlite-adapter.test.ts</code>{" "}
              (cross-tenant isolation) and{" "}
              <code className={code}>migration-tenant.test.ts</code> (upgrade
              path).
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
                <code className={code}>npm audit signatures</code>.
              </li>
              <li>
                <strong className="text-text-primary">SPDX SBOMs.</strong> A
                Software Bill of Materials ships with every release, covering
                direct and transitive dependencies for both the npm package
                and the Docker image. Attached to the GitHub release page as{" "}
                <code className={code}>iris-npm-sbom.spdx.json</code> and{" "}
                <code className={code}>iris-docker-sbom.spdx.json</code>.
              </li>
              <li>
                <strong className="text-text-primary">Cosign signatures.</strong>{" "}
                Docker images are signed with Sigstore cosign using GitHub
                OIDC (no long-lived signing key). Verify with:
                <pre className="mt-2 overflow-x-auto rounded bg-bg-surface p-3 font-mono text-[12px] leading-relaxed text-text-primary">
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
                <code className={code}>attest-build-provenance</code>{" "}
                attestations. Inspect with{" "}
                <code className={code}>gh attestation verify</code>.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">
              Runtime defenses
            </h2>
            <p className="mb-3">
              <strong className="text-text-primary">
                Every figure in this section is a configuration default,
              </strong>{" "}
              read from the line of source that enforces it when this page is
              built. None of them is a measurement: they say what the shipped
              server refuses out of the box, not how it performed under load.
              Change a value in <code className={code}>config.json</code> and
              the figure here no longer describes your install. The one
              measured section on this page is{" "}
              <a href="#fix-latency" className="font-semibold text-text-accent hover:underline">
                how fast things get fixed
              </a>
              , below.
            </p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-text-primary">Helmet headers</strong> on
                the dashboard API (HSTS, X-Frame-Options, X-Content-Type-Options,
                strict CSP).
              </li>
              <li>
                <strong className="text-text-primary">Bearer-token auth</strong>{" "}
                on HTTP mode with{" "}
                <code className={code}>crypto.timingSafeEqual</code>
                -based comparison to block timing side-channels. Off until you
                configure a key — HTTP mode is not authenticated by default.
              </li>
              <li>
                <strong className="text-text-primary">Rate limiting</strong>{" "}
                (configuration): {RATE_LIMIT_MCP} req/min on MCP endpoints,{" "}
                {RATE_LIMIT_API} req/min on dashboard APIs, standard RateLimit
                headers. Configurable via{" "}
                <code className={code}>security.rateLimit</code>.
              </li>
              <li>
                <strong className="text-text-primary">Zod input validation</strong>{" "}
                on every MCP tool and REST endpoint. Invalid requests fail
                fast with structured errors.
              </li>
              <li>
                <strong className="text-text-primary">ReDoS protection</strong>{" "}
                (configuration): every match of a user-supplied regex runs in a
                sandbox worker thread under a hard {REGEX_MATCH_BUDGET_MS} ms
                deadline. A match still backtracking at the deadline is
                terminated mid-execution and the rule reports{" "}
                <code className={code}>skipped</code> with{" "}
                <code className={code}>budgetExceeded: true</code>; a
                per-evaluation circuit breaker opens after{" "}
                {REGEX_BREACHES_PER_EVALUATION} breaches, so one hostile request
                cannot stall the server no matter how many regex rules it
                carries. <code className={code}>safe-regex2</code> and the{" "}
                {CUSTOM_REGEX_MAX_LENGTH.toLocaleString("en-US")}-character
                pattern cap remain as fast-path rejection, not as the boundary —
                safe-regex2 is a star-height heuristic and{" "}
                <code className={code}>(a|a)*$</code> passes it.{" "}
                <strong className="text-text-primary">
                  The trade-off, stated plainly:
                </strong>{" "}
                this fails <em>open</em> per rule. A budget-killed rule did not
                judge the output, so an adversary who knows your pattern can
                craft input that stalls it into skipping. Failing closed would
                let the same adversary force false violations on benign output,
                which is worse for an eval product — so the{" "}
                <code className={code}>budgetExceeded</code> flag is exported
                precisely so a gate that must fail closed can treat those skips
                as failures on its own terms.
              </li>
              <li>
                <strong className="text-text-primary">Request size limit</strong>{" "}
                (configuration): {humanSize(REQUEST_SIZE_LIMIT)} per request
                body on the dashboard API and the HTTP transport, to prevent
                memory-exhaustion attacks. Configurable via{" "}
                <code className={code}>security.requestSizeLimit</code>.
              </li>
            </ul>
          </section>

          <section id="fix-latency" className="scroll-mt-28">
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">
              How fast things get fixed
            </h2>
            <p>
              <strong className="text-text-primary">This section is measured,</strong>{" "}
              not asserted. The figures are computed from the public GitHub
              issues API for{" "}
              <a
                href={`https://github.com/${m.repo}`}
                className="font-semibold text-text-accent hover:underline"
                rel="noopener noreferrer"
                target="_blank"
              >
                {m.repo}
              </a>{" "}
              and re-sampled by hand, so the sample date matters more than the
              numbers: an old date means nobody has looked lately.
            </p>
            <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-border-default bg-bg-card p-4">
                <dt className="min-h-[2.75em] text-[11px] font-bold uppercase leading-snug tracking-[0.15em] text-text-muted">
                  Issues closed
                </dt>
                <dd className="mt-1 font-mono text-2xl font-semibold text-text-primary">
                  {m.issues.closedInWindow}
                </dd>
                <dd className="mt-1 text-[12px] text-text-muted">
                  last {m.windowDays} days
                </dd>
              </div>
              <div className="rounded-xl border border-border-default bg-bg-card p-4">
                <dt className="min-h-[2.75em] text-[11px] font-bold uppercase leading-snug tracking-[0.15em] text-text-muted">
                  Median time to close
                </dt>
                <dd className="mt-1 font-mono text-2xl font-semibold text-text-primary">
                  {m.issues.medianHoursToClose === null
                    ? "—"
                    : `${m.issues.medianHoursToClose.toFixed(1)} h`}
                </dd>
                <dd className="mt-1 text-[12px] text-text-muted">
                  {m.issues.medianHoursToClose === null
                    ? "no sample"
                    : `${(m.issues.medianHoursToClose / 24).toFixed(1)} days`}
                </dd>
              </div>
              <div className="rounded-xl border border-border-default bg-bg-card p-4">
                <dt className="min-h-[2.75em] text-[11px] font-bold uppercase leading-snug tracking-[0.15em] text-text-muted">
                  p75 time to close
                </dt>
                <dd className="mt-1 font-mono text-2xl font-semibold text-text-primary">
                  {m.issues.p75HoursToClose === null
                    ? "—"
                    : `${m.issues.p75HoursToClose.toFixed(1)} h`}
                </dd>
                <dd className="mt-1 text-[12px] text-text-muted">
                  {m.issues.p75HoursToClose === null
                    ? "no sample"
                    : `${(m.issues.p75HoursToClose / 24).toFixed(1)} days`}
                </dd>
              </div>
              <div className="rounded-xl border border-border-default bg-bg-card p-4">
                <dt className="min-h-[2.75em] text-[11px] font-bold uppercase leading-snug tracking-[0.15em] text-text-muted">
                  Open now
                </dt>
                <dd className="mt-1 font-mono text-2xl font-semibold text-text-primary">
                  {m.issues.openNow}
                </dd>
                <dd className="mt-1 text-[12px] text-text-muted">issues, not PRs</dd>
              </div>
            </dl>
            <p className="mt-4 text-[13px] leading-relaxed text-text-muted">
              Sampled {longDate(m.sampledAt)}
              {m.source === "cached"
                ? " — the API was unreachable at the last refresh, so these are the previous sample's figures"
                : ""}
              . n = {m.issues.closedInWindow} closed ({m.issues.closedAsCompleted} completed,{" "}
              {m.issues.closedAsNotPlanned} closed as not planned); median{" "}
              {hoursAndDays(m.issues.medianHoursToClose)}, p75{" "}
              {hoursAndDays(m.issues.p75HoursToClose)}.
              {smallSample
                ? " With a sample this small, one long-lived issue moves the p75 by days; read the median as the typical case and the p75 as the tail."
                : ""}{" "}
              Method: {m.method} Check it against{" "}
              <a
                href={closedIssuesUrl}
                className="font-semibold text-text-accent hover:underline"
                rel="noopener noreferrer"
                target="_blank"
              >
                the closed issues
              </a>{" "}
              and{" "}
              <a
                href={openIssuesUrl}
                className="font-semibold text-text-accent hover:underline"
                rel="noopener noreferrer"
                target="_blank"
              >
                the open ones
              </a>
              ; the generator is{" "}
              <code className={code}>scripts/claims/generators/issues.mjs</code>.
            </p>
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
                href={`mailto:${SECURITY_EMAIL}`}
                className="font-semibold text-text-accent hover:underline"
              >
                {SECURITY_EMAIL}
              </a>{" "}
              or use{" "}
              <a
                href={`${PUBLIC_REPO_URL}/security/advisories/new`}
                className="font-semibold text-text-accent hover:underline"
                rel="noopener noreferrer"
                target="_blank"
              >
                private vulnerability reporting
              </a>{" "}
              on GitHub. Please do not open a public GitHub issue for security
              matters.
            </p>
            <p className="mt-3">
              The commitments below are the ones in{" "}
              <a
                href={`${PUBLIC_REPO_URL}/blob/main/SECURITY.md`}
                className="font-semibold text-text-accent hover:underline"
                rel="noopener noreferrer"
                target="_blank"
              >
                SECURITY.md
              </a>
              , rendered from the same file so the two cannot disagree. They
              are best-effort targets from a solo maintainer; critical
              vulnerabilities get top priority regardless. We commit to:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-6">
              <li>Acknowledge your report within {DISCLOSURE_ACK_HOURS} hours.</li>
              <li>
                Provide a detailed response (confirmed / not a vulnerability /
                need more info) within {DISCLOSURE_RESPONSE_BUSINESS_DAYS} business
                days.
              </li>
              <li>
                Coordinate a disclosure timeline with you — we ask for{" "}
                {DISCLOSURE_WINDOW_DAYS} days by default, negotiable for
                high-severity or actively exploited issues.
              </li>
              <li>
                Release the fix, publish an advisory, and credit you in it and
                in the release notes unless you prefer to remain anonymous.
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
                  href="/proof"
                  className="font-semibold text-text-accent hover:underline"
                >
                  Proof
                </Link>{" "}
                — how accurate the evaluators themselves are, measured.
              </li>
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
                  href={`${PUBLIC_REPO_URL}/blob/main/docs/architecture.md`}
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
