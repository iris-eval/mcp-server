import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { IrisLogo } from "@/components/iris-logo";
import { CompareDisclaimer } from "@/components/compare-disclaimer";
import { OG_IMAGE_URL } from "@/lib/og";
import { COMPARISONS, compareBySlug, type CompareData, type CompareRow } from "@/lib/compare";
import { FEATURE_LABEL, IRIS_CELL, IRIS_FAQ_SENTENCE, IRIS_NEUTRAL, IRIS_REASONS, NOT_SERVER_TESTING } from "@/lib/compare/iris";

/*
 * One page for every comparison, rendered from website/src/lib/compare/
 * <vendor>.json (arc 8, R-5). The Iris side of every row comes from
 * lib/compare/iris.ts with its counts read from the truthbase; the vendor
 * side comes from the JSON, and every vendor cell links the vendor's own
 * page and shows the date it was read. Winner marks are Iris's editorial
 * call and the page says so; the sources are what a reader can check.
 * tests/compare-contract.test.ts locks the files to the schema, the
 * sources and the dates.
 */

export const dynamicParams = false;

export function generateStaticParams(): { slug: string }[] {
  return COMPARISONS.map((c) => ({ slug: c.slug }));
}

/** Sanitize a string for safe inclusion in JSON-LD structured data. */
function sanitizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .slice(0, 500);
}

function titleFor(c: CompareData): string {
  return `Iris vs ${c.name} — ${c.tagline}`;
}
function descriptionFor(c: CompareData): string {
  return `Iris and ${c.name} side by side, feature by feature, every ${c.name} cell sourced to its own documentation and dated. ${c.oneLine}`;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const c = compareBySlug(slug);
  if (!c) return {};
  const url = `https://iris-eval.com/compare/${c.slug}`;
  const image = c.ogImage ?? OG_IMAGE_URL;
  return {
    title: titleFor(c),
    description: descriptionFor(c),
    alternates: { canonical: url },
    openGraph: { title: titleFor(c), description: descriptionFor(c), url, images: [image] },
    twitter: { card: "summary_large_image", title: titleFor(c), description: descriptionFor(c), images: [image], site: "@iris_eval" },
  };
}

const link = "text-text-accent underline decoration-border-strong underline-offset-2 hover:text-iris-400";

function VendorCell({ row, name }: { row: CompareRow; name: string }): React.ReactElement {
  return (
    <>
      <span>{row.vendor}</span>
      <span className="mt-1 block font-mono text-[11px] text-text-muted">
        <a href={row.sourceUrl} className={link} rel="noopener noreferrer" title={row.quote}>
          {name}&apos;s page
        </a>{" "}
        · read {row.lastVerified}
      </span>
    </>
  );
}

export default async function ComparePage({ params }: { params: Promise<{ slug: string }> }): Promise<React.ReactElement> {
  const { slug } = await params;
  const c = compareBySlug(slug);
  if (!c) notFound();
  const url = `https://iris-eval.com/compare/${c.slug}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        headline: sanitizeText(titleFor(c)),
        description: sanitizeText(descriptionFor(c)),
        url,
        publisher: { "@type": "Organization", name: "Iris", url: "https://iris-eval.com" },
        mainEntityOfPage: url,
      },
      {
        "@type": "FAQPage",
        mainEntity: c.faq.map((f, i) => ({
          "@type": "Question",
          name: sanitizeText(f.question),
          acceptedAnswer: { "@type": "Answer", text: sanitizeText(i === 0 ? `${IRIS_FAQ_SENTENCE} ${f.vendorPart}` : f.vendorPart) },
        })),
      },
    ],
  };
  const irisWins = c.rows.filter((r) => r.verdict === "iris").length;
  const vendorWins = c.rows.filter((r) => r.verdict === "vendor").length;

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Nav />

      {/* Hero */}
      <section className="relative overflow-hidden bg-bg-base pb-12 pt-32 text-center lg:pt-40">
        <div className="glow-hero absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-30" aria-hidden="true" />
        <div className="relative mx-auto max-w-4xl px-6">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">Comparison · {c.category}</p>
          <h1 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl lg:text-6xl">
            <span className="text-gradient">Iris</span> vs {c.name}
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-text-secondary">{c.tagline}.</p>
        </div>
      </section>

      {/* TL;DR */}
      <section className="bg-bg-base pb-16">
        <div className="mx-auto max-w-3xl px-6">
          <p className="mb-6 text-center text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">TL;DR</p>
          <div className="rounded-2xl border border-border-default bg-bg-card p-8 text-[15px] leading-relaxed text-text-secondary">
            <strong className="text-text-primary">Iris</strong> is an MCP server your agent discovers and uses on connect — one config block, no SDK, one SQLite
            file, every rule&apos;s precision and recall published at <a href="https://iris-eval.com/proof" className={link}>iris-eval.com/proof</a>.{" "}
            <strong className="text-text-primary">{c.name}</strong> — from its own pages, read {c.lastVerified}:{" "}
            {c.tldrVendor}{" "}
            <a href={c.tldrSourceUrl} className={link} rel="noopener noreferrer">
              (source)
            </a>
            <p className="mt-4 text-[13px] text-text-muted">
              {NOT_SERVER_TESTING} For the method, see the{" "}
              <a href="/learn/agent-eval" className="text-iris-400 transition-colors hover:text-iris-300">
                agent eval guide
              </a>
              .
            </p>
          </div>
        </div>
      </section>

      {/* Feature comparison table */}
      <section className="bg-bg-base pb-20">
        <div className="mx-auto max-w-5xl px-6">
          <div className="mb-10 text-center">
            <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">Feature comparison</p>
            <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-text-primary md:text-4xl">Side by side.</h2>
            <p className="mx-auto mt-4 max-w-2xl text-[14px] text-text-muted">
              Twelve features, the same twelve on every comparison. Every {c.name} cell links the page it was read from and the date. The
              highlighted cells are Iris&apos;s own call on which side is stronger for a team running MCP agents — {irisWins} to Iris,{" "}
              {vendorWins} to {c.name} — not a measurement.
            </p>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-border-default bg-bg-card">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="border-b border-border-default">
                  <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-text-muted">Feature</th>
                  <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-text-accent">Iris</th>
                  <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-eval-pass">{c.name}</th>
                </tr>
              </thead>
              <tbody>
                {c.rows.map((row) => (
                  <tr key={row.id} className="border-b border-border-subtle transition-colors last:border-b-0 hover:bg-iris-600/[0.02]">
                    <td className="whitespace-nowrap px-6 py-4 align-top font-semibold text-text-primary">{FEATURE_LABEL[row.id]}</td>
                    <td
                      className={`px-6 py-4 align-top ${row.verdict === "iris" ? "font-medium text-text-accent" : IRIS_NEUTRAL.has(row.id) ? "text-text-muted" : "text-text-secondary"}`}
                    >
                      {IRIS_CELL[row.id]}
                    </td>
                    <td className={`px-6 py-4 align-top ${row.verdict === "vendor" ? "font-medium text-eval-pass" : "text-text-secondary"}`}>
                      <VendorCell row={row} name={c.name} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* When to choose */}
      <section className="bg-bg-base pb-20">
        <div className="mx-auto max-w-5xl px-6">
          <div className="mb-10 text-center">
            <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">Decision guide</p>
            <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-text-primary md:text-4xl">Which one fits your stack?</h2>
          </div>
          <div className="grid gap-8 md:grid-cols-2">
            <div className="rounded-2xl border border-border-default bg-bg-card p-8 transition-colors hover:border-border-glow">
              <h3 className="mb-6 flex items-center gap-3 font-display text-xl font-bold text-text-primary">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-iris-500/30 bg-iris-600/10">
                  <IrisLogo size={18} />
                </span>
                When to choose Iris
              </h3>
              <ul className="space-y-3">
                {IRIS_REASONS.map((reason) => (
                  <li
                    key={reason}
                    className="relative pl-4 text-[14px] leading-relaxed text-text-secondary before:absolute before:left-0 before:top-[9px] before:h-[7px] before:w-[7px] before:rounded-full before:bg-iris-500"
                  >
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-border-default bg-bg-card p-8 transition-colors hover:border-border-glow">
              <h3 className="mb-6 flex items-center gap-3 font-display text-xl font-bold text-text-primary">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-eval-pass/30 bg-eval-pass/10">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" aria-hidden="true">
                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                    <path d="M2 17l10 5 10-5" />
                    <path d="M2 12l10 5 10-5" />
                  </svg>
                </span>
                When to choose {c.name}
              </h3>
              <ul className="space-y-3">
                {c.vendorReasons.map((reason) => (
                  <li
                    key={reason.text}
                    className="relative pl-4 text-[14px] leading-relaxed text-text-secondary before:absolute before:left-0 before:top-[9px] before:h-[7px] before:w-[7px] before:rounded-full before:bg-eval-pass"
                  >
                    {reason.text}{" "}
                    <a href={reason.sourceUrl} className={`${link} font-mono text-[11px]`} rel="noopener noreferrer">
                      source
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Sources */}
      <section className="bg-bg-base pb-12">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="font-display text-xl font-bold text-text-primary">Sources</h2>
          <p className="mt-2 text-[13px] text-text-muted">
            Every {c.name} statement on this page was read from one of these pages on the date shown. The file behind this page is{" "}
            <code className="rounded bg-bg-surface px-1.5 py-0.5 font-mono text-[12px] text-text-primary">website/src/lib/compare/{c.slug}.json</code>.
          </p>
          <ul className="mt-4 grid gap-1 text-[13px] sm:grid-cols-2">
            {c.sources.map((s) => (
              <li key={s.url} className="truncate">
                <a href={s.url} className={link} rel="noopener noreferrer">
                  {s.label}
                </a>{" "}
                <span className="font-mono text-[11px] text-text-muted">{s.lastVerified}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <CompareDisclaimer lastVerified={c.lastVerified} competitor={c.name} />

      {/* CTA */}
      <section className="bg-bg-base pb-20">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="font-display text-3xl font-extrabold tracking-tight text-text-primary md:text-4xl">Ready to see what your agents are doing?</h2>
          <p className="mt-5 text-lg text-text-secondary">Add Iris to your MCP config. First trace in 60 seconds. No SDK, no signup, no infrastructure.</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/#open-source"
              className="inline-flex items-center gap-2 rounded-xl bg-iris-600 px-8 py-4 text-[15px] font-semibold text-white shadow-lg shadow-iris-600/20 transition-all hover:bg-iris-500"
            >
              Install Iris
            </Link>
            <Link
              href="/compare"
              className="inline-flex items-center rounded-xl border border-border-default px-8 py-4 text-[15px] font-semibold text-text-secondary transition-all hover:border-border-glow hover:text-text-primary"
            >
              Every comparison
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
