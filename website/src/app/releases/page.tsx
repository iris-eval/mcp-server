import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { CURRENT_RELEASE_VERSION, PUBLIC_REPO_URL, VERSION_MCP_SERVER } from "@/lib/claims";
import { OG_IMAGE_URL } from "@/lib/og";
import changelog from "@/lib/changelog.generated.json";

/*
 * The release narrative, rendered from CHANGELOG.md. The
 * current release is shown whole — its lead, its paragraphs, every entry
 * under every heading — and every earlier release is one line with its
 * lead, linking to the GitHub release built from the same section by
 * scripts/changelog-section.mjs. The data is website/src/lib/
 * changelog.generated.json, written by website/scripts/render-changelog.mjs
 * and checked in CI against CHANGELOG.md, so this page cannot say anything
 * the changelog does not. tests/release-narrative.test.ts locks the render
 * to the truthbase's current version and headline.
 */

const current = changelog.current;
const history = changelog.history;
const DESCRIPTION = `What changed in Iris ${current.version} (${current.date}), rendered from the changelog: ${current.lead ?? "the release notes"}. Every earlier release, one line each.`;

export const metadata: Metadata = {
  title: "Releases — Iris",
  description: DESCRIPTION,
  alternates: { canonical: "https://iris-eval.com/releases" },
  openGraph: {
    title: `Iris ${current.version} — ${current.lead ?? "release notes"}`,
    description: DESCRIPTION,
    url: "https://iris-eval.com/releases",
    type: "website",
    images: [OG_IMAGE_URL],
  },
  twitter: {
    card: "summary_large_image",
    title: `Iris ${current.version} — ${current.lead ?? "release notes"}`,
    description: DESCRIPTION,
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

const code = "rounded bg-bg-surface px-1.5 py-0.5 font-mono text-[13px] text-text-primary";
const link = "font-semibold text-text-accent hover:underline";

/**
 * The changelog is written in a small, regular markdown: bold, code spans
 * and links. Render those three and nothing else; anything else stays text.
 */
function Inline({ text }: { text: string }): React.ReactElement {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g);
  return (
    <>
      {tokens.map((tok, i) => {
        if (tok.startsWith("**") && tok.endsWith("**")) {
          return (
            <strong key={i} className="text-text-primary">
              {tok.slice(2, -2)}
            </strong>
          );
        }
        if (tok.startsWith("`") && tok.endsWith("`")) {
          return (
            <code key={i} className={code}>
              {tok.slice(1, -1)}
            </code>
          );
        }
        const m = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        if (m) {
          const href = m[2];
          const internal = href.startsWith("/") || href.startsWith("https://iris-eval.com/");
          return internal ? (
            <Link key={i} href={href.replace("https://iris-eval.com", "")} className={link}>
              <Inline text={m[1]} />
            </Link>
          ) : (
            <a key={i} href={href} className={link} rel="noopener noreferrer">
              <Inline text={m[1]} />
            </a>
          );
        }
        return <span key={i}>{tok}</span>;
      })}
    </>
  );
}

function releaseUrl(version: string): string {
  return `${PUBLIC_REPO_URL}/releases/tag/v${version}`;
}

export default function ReleasesPage(): React.ReactElement {
  const earlier = history.filter((r) => r.version !== current.version);
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-4xl px-6 pb-24 pt-32 lg:px-8">
        <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">Releases</p>
        <h1 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">
          Iris {current.version}
          {current.lead ? <span className="block text-text-secondary">{current.lead}.</span> : null}
        </h1>
        <p className="mt-4 font-mono text-[13px] text-text-muted">
          {current.date} · rendered from{" "}
          <a href={`${PUBLIC_REPO_URL}/blob/v${VERSION_MCP_SERVER}/CHANGELOG.md`} className={link}>
            CHANGELOG.md
          </a>{" "}
          · the same section is the{" "}
          <a href={releaseUrl(current.version)} className={link}>
            GitHub release
          </a>
          {CURRENT_RELEASE_VERSION && CURRENT_RELEASE_VERSION !== current.version ? (
            <span> · the package is at {CURRENT_RELEASE_VERSION}</span>
          ) : null}
        </p>

        {current.intro.map((paragraph, i) => (
          <p key={i} className="mt-6 text-lg leading-relaxed text-text-secondary">
            <Inline text={paragraph} />
          </p>
        ))}

        {current.sections.map((section) => (
          <section key={section.title} className="mt-12">
            <h2 className="font-display text-2xl font-bold text-text-primary">{section.title}</h2>
            <ul className="mt-5 space-y-4">
              {section.items.map((item, i) => (
                <li
                  key={i}
                  className="relative whitespace-pre-line pl-5 text-[15px] leading-relaxed text-text-secondary before:absolute before:left-0 before:top-[11px] before:h-[7px] before:w-[7px] before:rounded-full before:bg-iris-500"
                >
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section className="mt-16">
          <h2 className="font-display text-2xl font-bold text-text-primary">Earlier</h2>
          <p className="mt-3 text-text-secondary">
            One line per release, the bold lead of its changelog section; each links to the release notes built from
            that section.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-[14px]">
              <thead>
                <tr className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-muted">
                  <th scope="col" className="w-[14%] px-3 py-3">
                    Version
                  </th>
                  <th scope="col" className="w-[16%] px-3 py-3">
                    Date
                  </th>
                  <th scope="col" className="px-3 py-3">
                    Lead
                  </th>
                  <th scope="col" className="w-[10%] px-3 py-3">
                    Entries
                  </th>
                </tr>
              </thead>
              <tbody>
                {earlier.map((r) => (
                  <tr key={r.version} className="border-t border-border-subtle align-top">
                    <td className="px-3 py-3 font-mono text-[13px]">
                      <a href={releaseUrl(r.version)} className={link}>
                        {r.version}
                      </a>
                    </td>
                    <td className="px-3 py-3 font-mono text-[13px] text-text-muted">
                      {r.date}
                      {r.note ? <span className="ml-2 rounded border border-border-strong px-1.5 text-[10px] uppercase tracking-[0.08em]">{r.note}</span> : null}
                    </td>
                    <td className="px-3 py-3 text-text-secondary">{r.lead ?? "—"}</td>
                    <td className="px-3 py-3 font-mono text-[13px] text-text-muted">{r.itemCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
