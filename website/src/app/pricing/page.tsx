import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import { OG_IMAGE_URL } from "@/lib/og";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Pricing — Iris",
  description:
    "Pay for evaluations, not traces. Free up to 10K evaluations / month. Pro starts at $25/mo. Enterprise custom. Iris is the agent eval standard for MCP.",
  alternates: { canonical: "https://iris-eval.com/pricing" },
  openGraph: {
    title: "Pricing — Iris",
    description:
      "Pay for evaluations, not traces. Free tier covers 10K evaluations / month.",
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
    name: "Free",
    subhead: "For solo devs + open source projects",
    price: "$0 / month",
    cta: {
      label: "Install",
      href: "https://github.com/iris-eval/mcp-server#install",
      primary: true,
    },
    features: [
      "10,000 evaluations / month",
      "All 13 built-in eval rules",
      "Custom Zod rules (unlimited)",
      "Dashboard + playground",
      "stdio + HTTP transports",
      "Community support (GitHub Issues + Discord)",
    ],
    footer: "Stays free for personal projects. No credit card required.",
  },
  {
    name: "Pro",
    subhead: "For small teams in production",
    price: "$25 / month base + usage",
    priceSubline: "typical team $5–$10K / year",
    cta: { label: "Join waitlist", href: "/#waitlist", primary: true },
    features: [
      "100,000 evaluations / month included",
      "$0.0005 per evaluation above that",
      "All Free-tier features",
      "LLM-as-judge rules (v0.4)",
      "Trace comparison (side-by-side)",
      "Cost breakdown by agent + rule",
      "Agent-level dashboard filtering",
      "Email support, 48h SLA",
      "Self-Calibrating Eval beta access (v0.5)",
    ],
    footer: "Billed monthly. Cancel any time.",
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
      "Usage-based pricing, committed volume discount",
      "All Pro-tier features",
      "Single sign-on (SAML + OIDC)",
      "Priority support, 4h SLA on P1",
      "Custom eval rule authoring services",
      "Security review + procurement support",
      "On-premise / VPC deployment option",
      "Compliance documentation (SOC 2 in progress)",
    ],
    footer: "Typical engagements start at $25K / year.",
  },
];

interface FaqItem {
  q: string;
  a: string;
}

const faq: FaqItem[] = [
  {
    q: "What's an evaluation?",
    a: "An evaluation is a single rule-check against a single agent output. Run a handful of rules against one trace, and you get one evaluation per rule. Traces themselves are free — we only meter the evaluations.",
  },
  {
    q: "Why price on evaluations instead of traces?",
    a: "Evaluations are the value unit. A trace with no rules applied is a log entry; a trace scored by 13 rules is an instrument. The Pro tier's 100K evaluations translates to roughly 8K traces with the default rule set, or more if you run a leaner subset.",
  },
  {
    q: "Can I self-host?",
    a: "Yes. The OSS MCP server (@iris-eval/mcp-server) runs locally today on npm + Docker; the dashboard + playground run in-process. The Cloud Starter tier (launching v0.5) adds hosted storage, scaling, and alerting on top of the same core. Enterprise VPC deployment combines the two.",
  },
  {
    q: "What's the Self-Calibrating Eval beta?",
    a: "A v0.5 feature that adjusts eval thresholds based on observed patterns in your traces, so rules stay useful as your agent evolves. Pro + Enterprise get early access. Details will ship with v0.5.",
  },
  {
    q: "Is the Free tier forever?",
    a: "The 10K evaluations / month threshold is the commitment we can make for individual use today. If your needs grow past it, Pro is priced to make the transition obvious.",
  },
  {
    q: "How does billing work for Cloud Starter waitlist?",
    a: "When Cloud Starter launches, waitlist members get first access + founding-member pricing lock for year 1. No payment until the tier goes live + you opt in.",
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
            Start with the Free tier &rarr;
          </a>
          <a
            href="/#waitlist"
            className="rounded-lg border border-border-subtle bg-bg-base px-6 py-3 text-sm font-semibold text-text-primary transition-colors hover:bg-border-subtle"
          >
            Join Cloud Starter waitlist &rarr;
          </a>
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
          Not sure which tier fits?
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-base text-text-secondary">
          Start on Free. Move to Pro when your team&apos;s production agents exceed 10K evaluations a month (roughly 1K traces a day with default rules). Contact Enterprise when you need SSO, SLA, or custom deployment.
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
