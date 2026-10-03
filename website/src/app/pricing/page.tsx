import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import { DATA_RESIDENCY, RULE_COUNT_BUILT_IN, SUPPORT_EMAIL } from "@/lib/claims";
import { OG_IMAGE_URL } from "@/lib/og";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Pricing — Iris",
  description:
    "Iris is open source and free to run — no evaluation limit, no account. Hosted and team features are under consideration, not under construction.",
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
    description: "Open source and free, with no evaluation limit and no account required.",
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

/*
 * What exists today: the open-source server, so it is the only card. Hosted
 * and team features are under consideration, not under construction, and get
 * a card when they exist.
 */
const edition = {
  name: "Open Source",
  subhead: "Everything Iris does, self-hosted",
  price: "$0",
  priceSubline: "MIT licensed — no limits, no account",
  cta: { label: "Install", href: "https://github.com/iris-eval/mcp-server#install" },
  features: [
    "Unlimited evaluations — no metering, no quota",
    `All ${RULE_COUNT_BUILT_IN} built-in eval rules`,
    "Custom Zod rules (unlimited)",
    "LLM-as-judge + citation verification (your API key, no proxy)",
    "Dashboard + playground",
    "stdio + HTTP transports",
    "Community support (GitHub Issues + Discussions)",
  ],
  footer: DATA_RESIDENCY,
};

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
    a: "No. LLM-as-judge and citation verification ship in the open-source server. They call Anthropic or OpenAI with your own API key and do not route through us, so you pay your provider directly with no markup. A per-evaluation cost cap is enforced before each call, and the heuristic rules stay free and offline.",
  },
  {
    q: "Can I self-host?",
    a: "Yes — that is how Iris runs: @iris-eval/mcp-server on npm or Docker, with the dashboard and playground in-process, on your machine or your own infrastructure.",
  },
  {
    q: "Is there a hosted or paid version?",
    a: "Not today. Iris runs as the open-source server on your machine or your own infrastructure. Hosted storage, shared team history and alerting are under consideration, not under construction. No feature that is free today will move behind a paywall: if a hosted version is offered, it will earn its price on hosting, shared team history and scale, not by taking away what you already have.",
  },
  {
    q: "Do you have SOC 2 or other compliance certifications?",
    a: "No. Iris runs on your infrastructure and sends no telemetry, so many teams with compliance requirements can use it; whether it meets yours is your assessment to make. Iris itself holds no certification, and none will be claimed before it is held.",
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
          Free to run. Open source, no limits.
        </h1>
        <p className="mt-6 text-lg text-text-secondary sm:text-xl">
          Iris scores agent output for quality, safety, and cost, and it runs entirely on your machine — MIT licensed, no evaluation limit, no account.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href="https://github.com/iris-eval/mcp-server#install"
            className="rounded-lg bg-iris-600 px-6 py-3 text-sm font-semibold text-white shadow-sm shadow-iris-600/20 transition-all hover:bg-iris-500"
          >
            Install the open-source server &rarr;
          </a>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="rounded-lg border border-border-subtle bg-bg-base px-6 py-3 text-sm font-semibold text-text-primary transition-colors hover:bg-border-subtle"
          >
            Tell us what is missing &rarr;
          </a>
        </div>
      </section>

      {/* What exists today */}
      <section className="mx-auto mt-20 max-w-xl" data-edition={edition.name}>
        <div className="flex flex-col rounded-2xl border border-border-subtle bg-bg-base p-8">
          <div className="mb-6">
            <h2 className="font-display text-2xl font-bold tracking-tight text-text-primary">{edition.name}</h2>
            <p className="mt-1 text-sm text-text-secondary">{edition.subhead}</p>
          </div>
          <div className="mb-6">
            <p className="font-mono text-2xl font-bold text-text-primary">{edition.price}</p>
            <p className="mt-1 text-sm text-text-muted">{edition.priceSubline}</p>
          </div>
          <a
            href={edition.cta.href}
            className="mb-8 block rounded-lg bg-iris-600 px-5 py-2.5 text-center text-sm font-semibold text-white shadow-sm shadow-iris-600/20 transition-all hover:bg-iris-500"
          >
            {edition.cta.label}
          </a>
          <ul className="mb-6 flex flex-1 flex-col gap-3">
            {edition.features.map((f) => (
              <li key={f} className="flex items-start gap-2 text-sm text-text-secondary">
                <span className="mt-0.5 text-text-accent" aria-hidden="true">✓</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-muted">{edition.footer}</p>
        </div>
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
          What exists today
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-base text-text-secondary">
          Today Iris is the open-source server. It has no evaluation limit and no account, and nothing in it is held back. If shared team history or hosted storage would help you, or something you need is missing, tell us at {SUPPORT_EMAIL}.
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
