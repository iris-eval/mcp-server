import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { CLIENTS, PUBLIC_REPO_URL, VERSION_MCP_SERVER, type ClientRow, type ClientStatus } from "@/lib/claims";
import { OG_IMAGE_URL } from "@/lib/og";

/*
 * The clients page: every MCP client Iris names as a place it runs, one row
 * each, rendered from `.claims.json` `clients` — the same rows the README
 * and llms.txt render their lists from. A row is verified when a test in
 * the repository drives that client's real integration surface on every CI
 * run; it is claimed when the installer writes the configuration shape the
 * client's own documentation describes and that writer is tested on the
 * shape, but nobody on the Iris side has watched the client connect. The
 * status word, the evidence, the source and the date it was read are the
 * row; tests/clients-contract.test.ts locks the file to the installer's
 * profiles and to the prose surfaces.
 */

const counts = CLIENTS.counts;
const DESCRIPTION = `The MCP clients Iris runs in, one row each: ${counts.verified} verified by a test on every CI run, ${counts.claimed} claimed from the client's own documentation — every row with what was checked, its source and the date it was read.`;

export const metadata: Metadata = {
  title: "Clients — Iris",
  description: DESCRIPTION,
  alternates: { canonical: "https://iris-eval.com/clients" },
  openGraph: {
    title: "Clients — where Iris is verified to run, and where it is claimed to",
    description: DESCRIPTION,
    url: "https://iris-eval.com/clients",
    type: "website",
    images: [OG_IMAGE_URL],
  },
  twitter: {
    card: "summary_large_image",
    title: "Clients — where Iris is verified to run, and where it is claimed to",
    description: DESCRIPTION,
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

const code = "rounded bg-bg-surface px-1.5 py-0.5 font-mono text-[13px] text-text-primary";
const link = "font-semibold text-text-accent hover:underline";

const STATUS_STYLE: Record<ClientStatus, string> = {
  verified: "bg-[color-mix(in_srgb,var(--iris-500)_22%,transparent)] text-text-primary border-[var(--iris-500)]",
  claimed: "bg-transparent text-text-muted border-[var(--border-strong)] border-dashed",
};

function StatusChip({ status }: { status: ClientStatus }): React.ReactElement {
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] ${STATUS_STYLE[status]}`}
    >
      {status}
    </span>
  );
}

/** Row text carries `code spans` in backticks; render them as code, the rest as text. */
function Inline({ text }: { text: string }): React.ReactElement {
  const parts = text.split(/`([^`]+)`/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className={code}>
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function evidenceUrl(path: string): string {
  return `${PUBLIC_REPO_URL}/blob/v${VERSION_MCP_SERVER}/${path}`;
}

function Row({ row }: { row: ClientRow }): React.ReactElement {
  return (
    <tr className="border-t border-border-subtle align-top">
      <td className="px-3 py-4">
        <div className="font-semibold text-text-primary">{row.name}</div>
        <div className="mt-2">
          <StatusChip status={row.status} />
        </div>
      </td>
      <td className="px-3 py-4 text-text-secondary">
        <Inline text={row.config} />
      </td>
      <td className="px-3 py-4 text-text-secondary">
        <Inline text={row.summary} />
        <ul className="mt-2 space-y-1">
          {row.evidence.map((path) => (
            <li key={path}>
              <a href={evidenceUrl(path)} className={`${link} font-mono text-[12px]`}>
                {path}
              </a>
            </li>
          ))}
        </ul>
      </td>
      <td className="px-3 py-4 text-text-secondary">
        <a href={row.source} className={link} rel="noopener noreferrer">
          the client&apos;s MCP documentation
        </a>
        <div className="mt-1 font-mono text-[12px] text-text-muted">read {row.lastChecked}</div>
      </td>
    </tr>
  );
}

export default function ClientsPage(): React.ReactElement {
  const verified = CLIENTS.rows.filter((r) => r.status === "verified");
  const claimed = CLIENTS.rows.filter((r) => r.status === "claimed");
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-7xl px-6 pb-24 pt-32 lg:px-8">
        <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">Clients</p>
        <h1 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">
          Where Iris is verified to run, and where it is claimed to.
        </h1>
        <p className="mt-6 max-w-3xl text-lg leading-relaxed text-text-secondary">
          Iris runs inside an MCP client. This is the list of the clients it names, one row each, with what was
          actually checked: <strong className="text-text-primary">{counts.verified} verified</strong> by a test on every
          CI run, <strong className="text-text-primary">{counts.claimed} claimed</strong> from the client&apos;s own
          documentation. Any other MCP client works the same way the claimed rows do — the configuration is one block
          — and gets a row here when someone checks it.
        </p>

        <dl className="mt-10 grid gap-6 md:grid-cols-2">
          <div className="card-premium p-6">
            <dt className="flex items-center gap-3 font-semibold text-text-primary">
              <StatusChip status="verified" /> means
            </dt>
            <dd className="mt-3 text-text-secondary">
              A test in the repository drives that client&apos;s real integration surface — the hook scripts, the
              manifest, a real ingest read back from the store — on every CI run. The evidence column links the test.
            </dd>
          </div>
          <div className="card-premium p-6">
            <dt className="flex items-center gap-3 font-semibold text-text-primary">
              <StatusChip status="claimed" /> means
            </dt>
            <dd className="mt-3 text-text-secondary">
              The installer writes the configuration shape the client&apos;s own documentation describes, and that
              writer is tested on the shape. Nobody on the Iris side has watched that client connect. The source column
              is the page the shape was read from, with the date.
            </dd>
          </div>
        </dl>

        <div className="mt-12 overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-left text-[14px]">
            <thead>
              <tr className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-muted">
                <th scope="col" className="w-[16%] px-3 py-3">
                  Client
                </th>
                <th scope="col" className="w-[26%] px-3 py-3">
                  What the installer writes
                </th>
                <th scope="col" className="w-[40%] px-3 py-3">
                  What was checked, and the evidence
                </th>
                <th scope="col" className="w-[18%] px-3 py-3">
                  Source
                </th>
              </tr>
            </thead>
            <tbody>
              {verified.map((row) => (
                <Row key={row.id} row={row} />
              ))}
              {claimed.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>

        <section className="mt-14 max-w-3xl">
          <h2 className="font-display text-2xl font-bold text-text-primary">How a row moves</h2>
          <p className="mt-4 text-text-secondary">
            A claimed row becomes verified when a test in the repository drives that client&apos;s real integration
            surface on every CI run, or when a session in that client is reported with the client&apos;s version and
            the tool list it showed. A row that stops being true is changed, not removed: the rows are locked to the
            installer&apos;s client profiles, so no client is called supported without one.{" "}
            <a href={`${PUBLIC_REPO_URL}/issues/new`} className={link}>
              Report a row
            </a>{" "}
            or read the file itself:{" "}
            <a href={`${PUBLIC_REPO_URL}/blob/v${VERSION_MCP_SERVER}/clients.json`} className={`${link} font-mono text-[13px]`}>
              clients.json
            </a>
            . The install itself is on the{" "}
            <Link href="/#open-source" className={link}>
              home page
            </Link>
            .
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
