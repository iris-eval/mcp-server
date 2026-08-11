import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { RULE_COUNT_BUILT_IN } from "@/lib/claims";
import { OG_IMAGE_URL } from "@/lib/og";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Pricing — Iris",
  description:
    "Iris is open source and free, with no evaluation limit and no account. Hosted and team features are under consideration, not under construction — there is no pricing yet.",
  alternates: { canonical: "https://iris-eval.com/pricing" },
  openGraph: {
    title: "Pricing — Iris",
    description:
      "Open source and free, with no evaluation limit and no account required.",
    url: "https://iris-eval.com/pricing",
    type: "website",
    images: [OG_IMAGE_URL],
  },
  twitter: {
    card: "summary_large_image",
    title: "Pricing — Iris",
    description: "Pay for evaluations, not traces.",
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

interface Tier {
  name: string;
  subhead: string;
  price: string;
  priceSubline?: string;
  cta: { label: string; href: string; primary?: boolean };
  features: string[];
  footer: string;
  highlighted?: boolean;
}

const tiers: Tier[] = [
  {
    name: "Open Source",
    subhead: "Everything Iris does today, self-hosted",
    price: "$0",
    priceSubline: "MIT licensed — no limits, no account",
    cta: {
      label: "Install",
      href: "https://github.com/iris-eval/mcp-server#install",
      primary: true,
    },
    features: [
      "Unlimited evaluations — no metering, no quota",
      `All ${RULE_COUNT_BUILT_IN} built-in eval rules`,
      "Custom Zod rules (unlimited)",
      "LLM-as-judge + citation verification (your API key, no proxy)",
      "Dashboard + playground",
      "stdio + HTTP transports",
      "Community support (GitHub Issues + Discord)",
    ],
    footer: "Runs entirely on your machine. Your traces never leave it.",
  },
  {
    name: "Team",
    subhead: "Shared history and hosted storage — planned",
    price: "Not yet priced",
    priceSubline: "nothing to buy today",
    cta: { label: "Join waitlist", href: "/#waitlist", primary: true },
    features: [
      "Everything in Open Source",
      "Managed hosting — no local database to run",
      "Shared team history across machines",
      "Trace comparison (side-by-side)",
      "Cost breakdown by agent + rule",
      "Agent-level dashboard filtering",
    ],
    footer:
      "Under consideration, not under construction. We will publish pricing when there is something to sell — and the open-source server will keep doing everything it does today.",
    highlighted: true,
  },
  {
    name: "Enterprise",
    subhead: "For organizations with volume + compliance needs",
    price: "Custom",
    cta: {
      label: "Contact sales",
      href: "mailto:hello@iris-eval.com?subject=Enterprise%20inquiry",
    },
    features: [
      "Everything in Team",
      "Single sign-on (SAML + OIDC)",
      "Custom eval rule authoring services",
      "Security review + procurement support",
      "On-premise / VPC deployment option",
    ],
    footer:
      "No compliance certifications have been started. If you need SOC 2 or similar today, we are not the right fit yet — the self-hosted server may still work for you, since it keeps all data on your own infrastructure.",
  },
];

interface FaqItem {
  q: string;
  a: string;
}

const faq: FaqItem[] = [
  {
    q: "What does it cost to run Iris today?",
    a: "Nothing. Iris is MIT licensed and runs on your own machine. There is no metering, no quota, no account, and no evaluation limit — the server does not count your usage, because there is nothing to count it for.",
  },
  {
    q: "Is LLM-as-judge a paid feature?",
    a: "No. LLM-as-judge and citation verification ship in the open-source server. They call Anthropic or OpenAI with your own API key and never route through us, so you pay your provider directly with no markup. A per-evaluation cost cap is enforced before each call, and the heuristic rules stay free and offline.",
  },
  {
    q: "Can I self-host?",
    a: "Self-hosting is the only way to run Iris right now — @iris-eval/mcp-server on npm or Docker, with the dashboard and playground in-process. Hosted options are described above as planned, not available.",
  },
  {
    q: "Will the open-source version get worse when a paid tier arrives?",
    a: "No feature that is free today will move behind a paywall. If a hosted tier ever ships, it will earn its price on hosting, shared team history and scale — not by removing something you already have.",
  },
  {
    q: "Do you have SOC 2 or other compliance certifications?",
    a: "No. None have been started, and we will say so plainly rather than imply otherwise. Because the server runs entirely on your infrastructure and sends no telemetry, many teams with compliance requirements can still use it — but that is your assessment to make, not a certification we hold.",
  },
  {
    q: "What is the waitlist actually for?",
    a: "It tells us whether hosted, team-shared storage is worth building. Joining costs nothing, commits you to nothing, and there is no price to be locked into yet.",
  },
];

export default function PricingPage(): React.ReactElement {
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-7xl px-6 py-16 lg:px-8 lg:py-24">
      {/* Hero */}
      <section className="mx-auto max-w-3xl text-center">
        <p className="text-sm font-medium uppercase tracking-wider text-text-accent">Pricing</p>
        <h1 className="mt-3 font-display text-4xl font-bold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
          Pay for evaluations, not traces.
        </h1>
        <p className="mt-6 text-lg text-text-secondary sm:text-xl">
          Iris scores every agent output for quality, safety, and cost. The evaluation is the value unit — that&apos;s what you pay for. Traces are commodity. Start free.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href="https://github.com/iris-eval/mcp-server#install"
            className="rounded-lg bg-iris-600 px-6 py-3 text-sm font-semibold text-white shadow-sm shadow-iris-600/20 transition-all hover:bg-iris-500"
          >
            Install the open-source server &rarr;
          </a>
          <Link
            href="/#waitlist"
            className="rounded-lg border border-border-subtle bg-bg-base px-6 py-3 text-sm font-semibold text-text-primary transition-colors hover:bg-border-subtle"
          >
            Tell us if you need hosted &rarr;
          </Link>
        </div>
      </section>

      {/* Tier grid */}
      <section className="mt-20 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {tiers.map((tier) => (
          <div
            key={tier.name}
            className={`flex flex-col rounded-2xl border p-8 transition-all ${
              tier.highlighted
                ? "border-iris-600 bg-iris-600/5 shadow-lg shadow-iris-600/10"
                : "border-border-subtle bg-bg-base"
            }`}
          >
            <div className="mb-6">
              <h2 className="font-display text-2xl font-bold tracking-tight text-text-primary">{tier.name}</h2>
              <p className="mt-1 text-sm text-text-secondary">{tier.subhead}</p>
            </div>
            <div className="mb-6">
              <p className="font-mono text-2xl font-bold text-text-primary">{tier.price}</p>
              {tier.priceSubline && (
                <p className="mt-1 text-sm text-text-muted">{tier.priceSubline}</p>
              )}
            </div>
            <a
              href={tier.cta.href}
              className={`mb-8 block rounded-lg px-5 py-2.5 text-center text-sm font-semibold transition-all ${
                tier.cta.primary
                  ? "bg-iris-600 text-white shadow-sm shadow-iris-600/20 hover:bg-iris-500"
                  : "border border-border-subtle bg-bg-base text-text-primary hover:bg-border-subtle"
              }`}
            >
              {tier.cta.label}
            </a>
            <ul className="mb-6 flex flex-1 flex-col gap-3">
              {tier.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-text-secondary">
                  <span className="mt-0.5 text-text-accent" aria-hidden="true">✓</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-text-muted">{tier.footer}</p>
          </div>
        ))}
      </section>

      {/* FAQ */}
      <section className="mx-auto mt-24 max-w-3xl">
        <h2 className="font-display text-3xl font-bold tracking-tight text-text-primary">FAQ</h2>
        <dl className="mt-10 flex flex-col gap-8">
          {faq.map((item) => (
            <div key={item.q}>
              <dt className="font-display text-lg font-semibold text-text-primary">{item.q}</dt>
              <dd className="mt-2 text-base text-text-secondary">{item.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Footer banner */}
      <section className="mx-auto mt-24 max-w-3xl rounded-2xl border border-border-subtle bg-bg-base p-8 text-center sm:p-12">
        <h2 className="font-display text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
          Which one do I need?
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-base text-text-secondary">
          The open-source server, because it is the only one that exists. It has no evaluation limit and no account, and it is what every feature listed above actually runs on. If shared team history or hosted storage would change your answer, tell us — that is how we decide whether to build it.
        </p>
        <a
          href="https://github.com/iris-eval/mcp-server#install"
          className="mt-8 inline-block rounded-lg bg-iris-600 px-6 py-3 text-sm font-semibold text-white shadow-sm shadow-iris-600/20 transition-all hover:bg-iris-500"
        >
          See the install docs &rarr;
        </a>
      </section>
    </main>
    <Footer />
    </>
  );
}
