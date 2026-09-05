import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { CAPABILITY_MAP, PUBLIC_REPO_URL, VERSION_MCP_SERVER, type CapabilityCell, type CapabilityStatus } from "@/lib/claims";
import { OG_IMAGE_URL } from "@/lib/og";

/*
 * The capability map: what Iris can judge, cell by cell, rendered from
 * `.claims.json` `capabilityMap` — the same file the server serves inside
 * iris://capabilities and docs/capabilities.md renders from. The statuses
 * are the four public ones; a gap is stated as a gap in Iris, never as a
 * claim about anyone else. tests/capability-map-contract.test.ts locks the
 * file to the release: every evidence name resolves to something
 * registered, and every registered rule, tool, template and resource
 * appears somewhere on the map.
 */

const counts = CAPABILITY_MAP.counts;
const DESCRIPTION = `What Iris can judge, cell by cell: ten evaluation questions against six subjects — ${counts.has} cells answered, ${counts.partial} answered with a stated limit, ${counts.gap} open gaps, ${counts["n/a"]} not applicable — each answered cell naming the rule, tool, resource or proof row behind it, for v${VERSION_MCP_SERVER}.`;

export const metadata: Metadata = {
  title: "Capabilities — Iris",
  description: DESCRIPTION,
  alternates: { canonical: "https://iris-eval.com/capabilities" },
  openGraph: {
    title: "Capabilities — what Iris can judge, and what it cannot yet",
    description: DESCRIPTION,
    url: "https://iris-eval.com/capabilities",
    type: "website",
    images: [OG_IMAGE_URL],
  },
  twitter: {
    card: "summary_large_image",
    title: "Capabilities — what Iris can judge, and what it cannot yet",
    description: DESCRIPTION,
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

const code = "rounded bg-bg-surface px-1.5 py-0.5 font-mono text-[13px] text-text-primary";
const link = "font-semibold text-text-accent hover:underline";

const STATUS_LABEL: Record<CapabilityStatus, string> = {
  has: "has",
  partial: "partial",
  gap: "gap",
  "n/a": "n/a",
};

const STATUS_STYLE: Record<CapabilityStatus, string> = {
  has: "bg-[color-mix(in_srgb,var(--iris-500)_22%,transparent)] text-text-primary border-[var(--iris-500)]",
  partial: "bg-[color-mix(in_srgb,var(--iris-500)_9%,transparent)] text-text-primary border-[var(--border-strong)]",
  gap: "bg-transparent text-text-muted border-[var(--border-strong)] border-dashed",
  "n/a": "bg-transparent text-text-muted border-transparent",
};

function StatusChip({ status }: { status: CapabilityStatus }): React.ReactElement {
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function cellFor(question: string, subject: string): CapabilityCell {
  const cell = CAPABILITY_MAP.cells.find((c) => c.question === question && c.subject === subject);
  if (!cell) throw new Error(`capability map: no cell for ${question} × ${subject}`);
  return cell;
}

function EvidenceChip({ kind, name }: { kind: string; name: string }): React.ReactElement {
  const href =
    kind === "proof" ? "/proof" : kind === "rule" ? `${PUBLIC_REPO_URL}/blob/main/docs/api-reference.md#evaluation-rules` : kind === "tool" ? `${PUBLIC_REPO_URL}/blob/main/docs/api-reference.md#mcp-tools` : null;
  const body = (
    <span className="inline-flex items-center gap-1 rounded border border-[var(--border-strong)] px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
      <span className="text-text-muted">{kind}</span>
      <span className="text-text-primary">{name}</span>
    </span>
  );
  return href ? (
    <a href={href} className="hover:underline">
      {body}
    </a>
  ) : (
    body
  );
}

export default function CapabilitiesPage(): React.ReactElement {
  const { questions, subjects } = CAPABILITY_MAP;
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-6xl px-6 pb-24 pt-32">
        <p className="text-[12px] font-bold uppercase tracking-[0.15em] text-text-muted">Capabilities · v{VERSION_MCP_SERVER}</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight text-text-primary" style={{ textWrap: "balance" }}>
          What Iris can judge, and what it cannot yet
        </h1>
        <p className="mt-6 max-w-3xl text-[17px] leading-relaxed text-text-secondary">
          Ten evaluation questions against six subjects. <strong className="text-text-primary">has</strong> means at least one shipped, measured
          thing answers the question for that subject; <strong className="text-text-primary">partial</strong> means something answers it with
          a stated limit; <strong className="text-text-primary">gap</strong> means nothing does yet; <strong className="text-text-primary">n/a</strong>{" "}
          means the question does not apply. Every answered cell names its evidence, and each name resolves to something registered in this
          release — a test fails otherwise. A gap is stated as a gap in Iris, never as a claim about anyone else.
        </p>
        <p className="mt-4 max-w-3xl text-[15px] leading-relaxed text-text-secondary">
          The same map is served to agents inside <span className={code}>iris://capabilities</span>, rendered to{" "}
          <a className={link} href={`${PUBLIC_REPO_URL}/blob/main/docs/capabilities.md`}>
            docs/capabilities.md
          </a>
          , and cut from{" "}
          <a className={link} href={`${PUBLIC_REPO_URL}/blob/main/capability-map.json`}>
            capability-map.json
          </a>
          . Accuracy numbers behind the <em>has</em> cells are on{" "}
          <Link className={link} href="/proof">
            the proof page
          </Link>
          .
        </p>

        <dl className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {(["has", "partial", "gap", "n/a"] as const).map((s) => (
            <div key={s} className="rounded-lg border border-[var(--border-strong)] p-4">
              <dt className="text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted">{STATUS_LABEL[s]}</dt>
              <dd className="mt-1 font-mono text-2xl font-semibold tabular-nums text-text-primary">{counts[s]}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-12 overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <caption className="sr-only">Capability map: status per question and subject</caption>
            <thead>
              <tr>
                <th scope="col" className="border-b border-[var(--border-strong)] px-2 py-3 align-bottom text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted">
                  Question
                </th>
                {subjects.map((s) => (
                  <th key={s.id} scope="col" className="border-b border-[var(--border-strong)] px-2 py-3 align-bottom text-[11px] font-bold uppercase tracking-[0.12em] text-text-muted">
                    {s.text}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {questions.map((q) => (
                <tr key={q.id} className="border-b border-[var(--border-strong)]">
                  <th scope="row" className="px-2 py-3 text-left font-semibold text-text-primary">
                    <a href={`#${q.id}`} className="hover:underline">
                      {q.text}
                    </a>
                  </th>
                  {subjects.map((s) => {
                    const cell = cellFor(q.id, s.id);
                    return (
                      <td key={s.id} className="px-2 py-3 align-top">
                        <a href={`#${cell.id}`} title={cell.summary}>
                          <StatusChip status={cell.status} />
                        </a>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {questions.map((q) => (
          <section key={q.id} id={q.id} className="mt-16 scroll-mt-28">
            <h2 className="text-2xl font-bold tracking-tight text-text-primary">{q.text}</h2>
            <ul className="mt-6 space-y-6">
              {subjects.map((s) => {
                const cell = cellFor(q.id, s.id);
                return (
                  <li key={cell.id} id={cell.id} className="scroll-mt-28 rounded-lg border border-[var(--border-strong)] p-5">
                    <div className="flex flex-wrap items-center gap-3">
                      <StatusChip status={cell.status} />
                      <h3 className="text-[15px] font-semibold text-text-primary">{s.text}</h3>
                      <span className="font-mono text-[11px] text-text-muted">{cell.id}</span>
                    </div>
                    <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">{cell.summary}</p>
                    {cell.evidence.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {cell.evidence.map((e) => (
                          <EvidenceChip key={`${e.kind}:${e.name}`} kind={e.kind} name={e.name} />
                        ))}
                      </div>
                    )}
                    {cell.needs.length > 0 && (
                      <p className="mt-3 text-[12px] text-text-muted">
                        needs: {cell.needs.map((n) => (
                          <span key={n} className={`${code} mr-1`}>
                            {n}
                          </span>
                        ))}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </main>
      <Footer />
    </>
  );
}
