import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Learn Agent Eval — Iris",
  description:
    "The agent eval vocabulary. Learn the concepts that define the category: eval drift, eval tax, eval gap, eval coverage, eval-driven development, and more.",
  alternates: { canonical: "https://iris-eval.com/learn" },
  openGraph: {
    title: "Learn Agent Eval — Iris",
    description:
      "The agent eval vocabulary. Concepts that define the category.",
    url: "https://iris-eval.com/learn",
    type: "website",
    images: ["/og-social-preview.png?v=3"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Learn Agent Eval — Iris",
    description:
      "The agent eval vocabulary. Concepts that define the category.",
    images: ["/og-social-preview.png?v=3"],
    site: "@iris_eval",
  },
};

const vocabularyTerms = [
  {
    term: "Eval Drift",
    description:
      "Quality degradation over time as models and prompts change.",
    href: "/learn/eval-drift",
  },
  {
    term: "The Eval Tax",
    description:
      "The compounding cost of not evaluating agent outputs.",
    href: "/learn/eval-tax",
  },
  {
    term: "The Eval Gap",
    description:
      "The distance between demo performance and production reality.",
    href: "/learn/eval-gap",
  },
  {
    term: "Eval Coverage",
    description:
      "The percentage of agent executions being evaluated.",
    href: "/learn/eval-coverage",
  },
  {
    term: "Eval-Driven Development",
    description:
      "Write your eval rules before you write your prompt. TDD for agents.",
    href: "/learn/eval-driven-development",
  },
  {
    term: "The Eval Loop",
    description:
      "The continuous cycle: score, diagnose, calibrate, re-score.",
    href: "/learn/eval-loop",
  },
  {
    term: "Self-Calibrating Eval",
    description:
      "Eval systems that monitor their own scoring distribution and recommend adjustments.",
    href: "/learn/self-calibrating-eval",
  },
  {
    term: "Output Quality Score",
    description:
      "A composite metric that rolls completeness, relevance, safety, and cost into one number.",
    href: "/learn/output-quality-score",
  },
];

export default function LearnIndex() {
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Learn Agent Eval",
    description:
      "The agent eval vocabulary. Concepts that define the category.",
    url: "https://iris-eval.com/learn",
    isPartOf: {
      "@type": "WebSite",
      name: "Iris",
      url: "https://iris-eval.com",
    },
    breadcrumb: {
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: "https://iris-eval.com",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Learn",
          item: "https://iris-eval.com/learn",
        },
      ],
    },
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <main className="mx-auto max-w-4xl px-6 py-16">
        <nav className="mb-8 text-sm text-text-secondary">
          <Link href="/" className="hover:text-iris-400">
            Home
          </Link>
          <span className="mx-2">/</span>
          <span className="text-text-primary">Learn</span>
        </nav>

        <h1 className="mb-4 text-4xl font-bold tracking-tight text-text-primary">
          Learn Agent Eval
        </h1>
        <p className="mb-12 text-lg text-text-secondary max-w-2xl">
          The agent eval vocabulary. These are the concepts that define the
          category — coined by Iris, grounded in practice, and backed by
          research.
        </p>

        <Link
          href="/learn/agent-eval"
          className="mb-12 block rounded-xl border-2 border-iris-500/50 bg-surface-primary p-8 transition-colors hover:border-iris-400"
        >
          <div className="text-xs font-medium uppercase tracking-wider text-iris-400 mb-2">
            Cornerstone Guide
          </div>
          <h2 className="text-2xl font-bold text-text-primary mb-2">
            Agent Eval: The Definitive Guide
          </h2>
          <p className="text-text-secondary">
            The complete reference for evaluating AI agent outputs —
            methodologies, implementation patterns, vocabulary, and code
            examples. Start here.
          </p>
        </Link>

        <h2 className="mb-6 text-xl font-semibold text-text-primary">
          The Vocabulary
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {vocabularyTerms.map((item) => (
            <Link
              key={item.term}
              href={item.href}
              className="rounded-lg border border-border-default bg-surface-primary p-5 transition-colors hover:border-iris-500/40"
            >
              <h3 className="font-semibold text-text-primary mb-1">
                {item.term}
              </h3>
              <p className="text-sm text-text-secondary">
                {item.description}
              </p>
            </Link>
          ))}
        </div>

        <div className="mt-12 rounded-lg border border-border-default bg-surface-primary p-6 text-center">
          <p className="text-text-secondary text-sm">
            Each term has a dedicated reference page with definitions, detection patterns, and FAQ.
            For deeper analysis, follow the link to the full blog post from each page.
          </p>
        </div>
      </main>
    </>
  );
}
