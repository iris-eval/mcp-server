import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import {
  PROOF,
  PUBLIC_REPO_URL,
  RULE_CATEGORIES,
  RULE_COUNT_BUILT_IN,
  RULE_NAMES,
  VERSION_MCP_SERVER,
  type ProofRule,
} from "@/lib/claims";
import { OG_IMAGE_URL } from "@/lib/og";

/*
 * The proof page renders `.claims.json` `proof` — per-rule precision, recall
 * and F1 with 95% confidence intervals, written by the proof generator from
 * proof/results.json. When the field is absent the page states that the
 * measurement is in progress and shows the method and the scope; it never
 * shows a placeholder number. Both states are built from the same file, so
 * the page cannot claim more than the truthbase holds.
 */

const measured = PROOF !== null && PROOF.rules.length > 0;

const DESCRIPTION = measured
  ? `Per-rule precision, recall and F1 with 95% confidence intervals for the ${PROOF!.rules.length} measured built-in Iris eval rules, the method, the corpus provenance, and the one command that reproduces the numbers.`
  : `How often the built-in Iris evaluators are wrong: the method, the corpus provenance and the reproduction command, with per-rule precision, recall and F1 and 95% confidence intervals published here as they are measured.`;

export const metadata: Metadata = {
  title: "Proof — Iris",
  description: DESCRIPTION,
  alternates: { canonical: "https://iris-eval.com/proof" },
  openGraph: {
    title: "Proof — how accurate Iris's evaluators are",
    description: DESCRIPTION,
    url: "https://iris-eval.com/proof",
    type: "website",
    images: [OG_IMAGE_URL],
  },
  twitter: {
    card: "summary_large_image",
    title: "Proof — how accurate Iris's evaluators are",
    description: DESCRIPTION,
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

const code = "rounded bg-bg-surface px-1.5 py-0.5 font-mono text-[13px] text-text-primary";
const link = "font-semibold text-text-accent hover:underline";

const fmt = (v: number): string => v.toFixed(2);

function longDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/*
 * One metric: the point estimate as a tick, the 95% interval as a band, on a
 * 0..1 track. Colour is never the only signal — the number sits beside the
 * bar in text ink, and the SVG carries the full reading as its label. Tokens
 * come from the site's theme so the mark reads in both colour schemes.
 */
function RangeBar({
  value,
  lo,
  hi,
  label,
}: {
  value: number;
  lo: number;
  hi: number;
  label: string;
}): React.ReactElement {
  const W = 88;
  const H = 12;
  const x = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * W * 100) / 100;
  const bandW = Math.max(x(hi) - x(lo), 1.5);
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      className="shrink-0"
    >
      <title>{label}</title>
      <rect x="0" y="5" width={W} height="2" rx="1" fill="var(--border-strong)" />
      <rect x={x(lo)} y="3" width={bandW} height="6" rx="2" fill="var(--iris-500)" fillOpacity="0.35" />
      <rect
        x={x(value) - 1.25}
        y="0"
        width="2.5"
        height={H}
        rx="1.25"
        fill="var(--iris-500)"
        stroke="var(--bg-base)"
        strokeWidth="1"
      />
    </svg>
  );
}

function MetricCell({
  name,
  value,
  ci,
}: {
  name: string;
  value: number;
  ci: [number, number];
}): React.ReactElement {
  const [lo, hi] = ci;
  return (
    <td className="px-2 py-3 align-middle">
      <div className="flex items-center gap-2">
        <span className="w-9 shrink-0 font-mono text-[14px] font-semibold tabular-nums text-text-primary">
          {fmt(value)}
        </span>
        <div className="flex flex-col gap-1">
          <RangeBar
            value={value}
            lo={lo}
            hi={hi}
            label={`${name} ${fmt(value)}, 95% interval ${fmt(lo)} to ${fmt(hi)}`}
          />
          <span className="font-mono text-[11px] tabular-nums text-text-muted">
            {fmt(lo)}–{fmt(hi)}
          </span>
        </div>
      </div>
    </td>
  );
}

function groupByCategory(rules: ProofRule[]): Array<{ category: string; rules: ProofRule[] }> {
  const groups = new Map<string, ProofRule[]>();
  for (const r of rules) {
    const list = groups.get(r.category) ?? [];
    list.push(r);
    groups.set(r.category, list);
  }
  const known = RULE_CATEGORIES.filter((c) => groups.has(c));
  const other = [...groups.keys()].filter((k) => !RULE_CATEGORIES.includes(k));
  return [...known, ...other].map((category) => ({
    category,
    rules: groups.get(category) ?? [],
  }));
}

function RuleTable({ category, rules }: { category: string; rules: ProofRule[] }): React.ReactElement {
  return (
    <div className="mt-8">
      <h3 className="mb-3 font-display text-lg font-bold capitalize text-text-primary">{category}</h3>
      <div className="overflow-x-auto rounded-xl border border-border-default bg-bg-card">
        <table className="w-full min-w-[760px] border-collapse text-left text-[14px]">
          <thead>
            <tr className="border-b border-border-default text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted">
              <th scope="col" className="w-[21%] px-3 py-3 font-bold">Rule</th>
              <th scope="col" className="w-[22%] px-3 py-3 font-bold normal-case tracking-normal">n</th>
              <th scope="col" className="px-2 py-3 font-bold">Precision</th>
              <th scope="col" className="px-2 py-3 font-bold">Recall</th>
              <th scope="col" className="px-2 py-3 font-bold">F1</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.name} className="border-b border-border-subtle last:border-b-0">
                <th scope="row" className="px-3 py-3 align-middle font-mono text-[13px] font-medium text-text-primary">
                  {r.name}
                </th>
                <td className="px-3 py-3 align-middle font-mono text-[13px] tabular-nums text-text-secondary">
                  <div className="whitespace-nowrap">
                    {r.n} <span className="text-text-muted">= {r.positives} + / {r.negatives} −</span>
                  </div>
                  <div className="whitespace-nowrap text-[11px] text-text-muted">
                    tp {r.tp} · fp {r.fp} · fn {r.fn} · tn {r.tn}
                  </div>
                </td>
                <MetricCell name="precision" value={r.precision} ci={r.ci95.precision} />
                <MetricCell name="recall" value={r.recall} ci={r.ci95.recall} />
                <MetricCell name="F1" value={r.f1} ci={r.ci95.f1} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Results(): React.ReactElement {
  const proof = PROOF!;
  const corpusSize = proof.rules.reduce((sum, r) => sum + r.n, 0);
  const groups = groupByCategory(proof.rules);
  const unmeasured = RULE_NAMES.filter((n) => !proof.rules.some((r) => r.name === n));
  return (
    <>
      <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { k: "Rules measured", v: `${proof.rules.length} / ${RULE_COUNT_BUILT_IN}` },
          { k: "Labelled cases", v: corpusSize.toLocaleString("en-US") },
          { k: "Corpus", v: proof.corpusVersion },
          { k: "Generated", v: String(proof.generatedAt).slice(0, 10) },
        ].map((t) => (
          <div key={t.k} className="rounded-xl border border-border-default bg-bg-card p-4">
            <dt className="text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted">{t.k}</dt>
            <dd className="mt-1 font-mono text-xl font-semibold text-text-primary">{t.v}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-6 text-[13px] text-text-muted">
        Bar = 95% confidence interval · tick = point estimate · scale 0 to 1. n
        splits into labelled violations (+) and labelled clean outputs (−); tp,
        fp, fn, tn are the confusion counts the three figures are computed from.
      </p>

      {groups.map((g) => (
        <RuleTable key={g.category} category={g.category} rules={g.rules} />
      ))}

      {unmeasured.length > 0 && (
        <p className="mt-6 text-[14px] leading-relaxed text-text-secondary">
          <strong className="text-text-primary">Not yet in the table:</strong>{" "}
          {unmeasured.map((n, i) => (
            <span key={n}>
              <code className={code}>{n}</code>
              {i < unmeasured.length - 1 ? ", " : ""}
            </span>
          ))}
          . A rule that is not here has not been measured, and a verdict from it carries no
          quantified trust.
        </p>
      )}
    </>
  );
}

function InProgress(): React.ReactElement {
  return (
    <section className="mt-8 rounded-xl border border-border-default bg-bg-card p-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-text-accent">
        Measurement in progress
      </p>
      <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
        The numbers are not here yet, and{" "}
        <strong className="text-text-primary">nothing on this page is a placeholder.</strong>{" "}
        Iris v{VERSION_MCP_SERVER} ships {RULE_COUNT_BUILT_IN} built-in rules whose verdicts,
        as of today, carry no published accuracy figure. Until the table lands, treat every{" "}
        <code className={code}>passed: true</code> as an unquantified judgment — the rules are
        deterministic and their source is public, but how often they are wrong has not been
        stated here.
      </p>
      <p className="mt-4 text-[14px] leading-relaxed text-text-secondary">
        What will appear, per rule: precision, recall and F1 with 95% confidence intervals on a
        labelled corpus committed to the repository, the confusion counts behind them, and the
        commit and corpus version they were computed at. The rules in scope:
      </p>
      <p className="mt-3 flex flex-wrap gap-1.5">
        {RULE_NAMES.map((n) => (
          <code key={n} className={code}>
            {n}
          </code>
        ))}
      </p>
    </section>
  );
}

export default function Proof(): React.ReactElement {
  const proof = PROOF;
  const humanAgreement = proof?.humanAgreement;
  const judge = proof?.judge;
  return (
    <>
      <Nav />
      <article className="mx-auto max-w-4xl px-6 pb-20 pt-32 lg:pt-40">
        <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">Proof</p>
        <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-balance text-text-primary md:text-4xl">
          How often the evaluators themselves are wrong
        </h1>
        <p className="mt-5 max-w-3xl text-[16px] leading-relaxed text-text-secondary">
          Every eval tool tells you your agent&rsquo;s score. This page tells you how much to
          trust the scorer: each built-in rule&rsquo;s precision, recall and F1, with the
          uncertainty shown rather than hidden, on a corpus you can download, from a command you
          can run.
        </p>
        {measured && (
          <p className="mt-3 text-[13px] text-text-muted">
            Generated {longDate(proof!.generatedAt)} at commit{" "}
            <a href={`${PUBLIC_REPO_URL}/commit/${proof!.commit}`} className={`${link} font-mono`} rel="noopener noreferrer" target="_blank">
              {proof!.commit}
            </a>{" "}
            · corpus <span className="font-mono">{proof!.corpusVersion}</span> · schema v
            {proof!.schemaVersion}
          </p>
        )}

        {measured ? <Results /> : <InProgress />}

        <div className="mt-14 space-y-10 text-[15px] leading-relaxed text-text-secondary">
          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">How to read it</h2>
            <p>
              Each rule is run over a labelled corpus of agent outputs: precision is the share of
              outputs the rule flagged that were truly violations, recall is the share of true
              violations the rule flagged, and F1 is their harmonic mean. The intervals are 95%
              confidence intervals
              {proof?.method ? (
                <>
                  {" "}
                  (<span className="font-mono text-[13px]">{proof.method.ci}</span> for precision and
                  recall, <span className="font-mono text-[13px]">{proof.method.f1Ci}</span> for F1)
                </>
              ) : null}
              ; a wide bar means a small sample, not a bad rule, and a rule whose interval reaches
              low is one whose verdict you should not gate a deploy on alone.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">
              Where the corpus came from
            </h2>
            <p>The disclosures that matter, stated before the numbers are read:</p>
            <ul className="mt-3 list-disc space-y-2 pl-6">
              <li>
                <strong className="text-text-primary">Synthetic.</strong> The cases are
                constructed, not sampled from production traffic. They cover the shapes the
                rules are meant to catch; they do not tell you the base rate in your agent.
              </li>
              <li>
                <strong className="text-text-primary">LLM-authored.</strong> A language model
                wrote the cases, so they share one author&rsquo;s idea of what a violation looks
                like.
              </li>
              <li>
                <strong className="text-text-primary">Same-model-labelled.</strong> The labels
                were produced by the same model family that authored the cases, which means the
                labels share the author&rsquo;s blind spots. A rule that agrees with those
                labels agrees with that model, not yet with a human.
              </li>
              <li>
                <strong className="text-text-primary">Human blind label:</strong>{" "}
                {humanAgreement ? (
                  <>
                    <span className="capitalize">{humanAgreement.status}</span>. {humanAgreement.note}
                  </>
                ) : (
                  <>
                    pending. A stratified sample is to be labelled blind by a human and the
                    agreement with the corpus labels reported here.
                  </>
                )}
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">
              What is not in the table
            </h2>
            <p>
              The LLM-judge path (<code className={code}>evaluate_with_llm_judge</code>) and the
              citation verifier (<code className={code}>verify_citations</code>) are semantic,
              model-backed, and not deterministic; they are measured separately, on an
              adversarial set, under a cost cap.{" "}
              {judge ? (
                <>
                  Status: <strong className="text-text-primary capitalize">{judge.status}</strong>
                  {typeof judge.note === "string" && judge.note ? `. ${judge.note}` : "."}
                </>
              ) : (
                <>
                  Status: <strong className="text-text-primary">pending</strong>. Until a
                  false-positive rate per template is published here, a judge score is a
                  rubric-guided model judgment and nothing more.
                </>
              )}
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Run it yourself</h2>
            <p>
              The corpus, the runner and the results file live in the repository. The numbers on
              this page are the committed results; regenerate them and diff:
            </p>
            <pre className="mt-3 overflow-x-auto rounded-xl border border-border-default bg-bg-surface p-4 font-mono text-[13px] leading-relaxed text-text-primary">
              {`git clone https://github.com/iris-eval/mcp-server.git
cd mcp-server
npm ci
npm run proof          # writes proof/results.json
git diff proof/results.json`}
            </pre>
            <p className="mt-3 text-[14px] text-text-muted">
              No network and no API key are needed: the built-in rules are deterministic, so the
              run completes offline and identical inputs produce identical figures. The page is
              rendered from the same results file through the truthbase (
              <code className={code}>.claims.json</code>), and the hardcoded-claim scanner refuses
              any public sentence that says &ldquo;measured&rdquo; without linking here.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Related</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <Link href="/security" className={link}>
                  Security
                </Link>{" "}
                — the controls in place, and measured issue-close times.
              </li>
              <li>
                <Link href="/#roadmap" className={link}>
                  Roadmap
                </Link>{" "}
                — Track 1 is this page; what comes after it.
              </li>
              <li>
                <a href={`${PUBLIC_REPO_URL}/blob/main/docs/roadmap.md`} className={link} rel="noopener noreferrer" target="_blank">
                  docs/roadmap.md
                </a>{" "}
                — the measurement commitments in full, including the ones not yet met.
              </li>
            </ul>
          </section>
        </div>
      </article>
      <Footer />
    </>
  );
}
