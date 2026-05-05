import type { Metadata } from "next";
import Link from "next/link";
import { OG_IMAGE_URL } from "@/lib/og";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Compare Iris — Agent Eval Alternatives",
  description:
    "See how Iris compares to other agent evaluation and observability platforms. MCP-native, zero-code integration, heuristic-first eval.",
  alternates: { canonical: "https://iris-eval.com/compare" },
  openGraph: {
    title: "Compare Iris — Agent Eval Alternatives",
    description:
      "See how Iris compares to other agent evaluation and observability platforms.",
    url: "https://iris-eval.com/compare",
    type: "website",
    images: [OG_IMAGE_URL],
  },
  twitter: {
    card: "summary_large_image",
    title: "Compare Iris — Agent Eval Alternatives",
    description:
      "See how Iris compares to other agent evaluation and observability platforms.",
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

const comparisons = [
  {
    name: "Langfuse",
    slug: "langfuse",
    tagline: "MCP-Native Agent Eval vs SDK-Based Tracing",
    category: "Observability",
  },
  {
    name: "LangSmith",
    slug: "langsmith",
    tagline: "MCP-Native Eval vs LangChain Ecosystem Tracing",
    category: "Observability",
  },
  {
    name: "Helicone",
    slug: "helicone",
    tagline: "MCP-Native Agent Eval vs API Gateway Observability",
    category: "Observability",
  },
  {
    name: "Braintrust",
    slug: "braintrust",
    tagline: "MCP-Native Eval vs Experiment-Driven Evaluation",
    category: "Evaluation",
  },
  {
    name: "Arize",
    slug: "arize",
    tagline: "MCP-Native Eval vs Enterprise ML Observability",
    category: "Observability",
  },
  {
    name: "DeepEval",
    slug: "deepeval",
    tagline: "MCP-Native Heuristic Eval vs LLM-as-Judge Framework",
    category: "Evaluation",
  },
  {
    name: "Confident AI",
    slug: "confident-ai",
    tagline: "MCP-Native Eval vs Cloud Evaluation Platform",
    category: "Evaluation",
  },
  {
    name: "Patronus AI",
    slug: "patronus-ai",
    tagline: "MCP-Native Eval vs Enterprise AI Safety Platform",
    category: "Safety",
  },
];

export default function CompareIndex() {
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Compare Iris",
    description:
      "See how Iris compares to other agent evaluation and observability platforms.",
    url: "https://iris-eval.com/compare",
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
          name: "Compare",
          item: "https://iris-eval.com/compare",
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
      <Nav />
      <main className="mx-auto max-w-4xl px-6 py-16">
        <nav className="mb-8 text-sm text-text-secondary">
          <Link href="/" className="hover:text-iris-400">
            Home
          </Link>
          <span className="mx-2">/</span>
          <span className="text-text-primary">Compare</span>
        </nav>

        <h1 className="mb-4 text-4xl font-bold tracking-tight text-text-primary">
          Compare Iris
        </h1>
        <p className="mb-12 text-lg text-text-secondary max-w-2xl">
          Iris is the MCP-native agent eval standard. See how it compares to
          other evaluation and observability platforms — feature by feature, with
          no vendor lock-in.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          {comparisons.map((item) => (
            <Link
              key={item.slug}
              href={`/compare/${item.slug}`}
              className="rounded-lg border border-border-default bg-surface-primary p-5 transition-colors hover:border-iris-500/40"
            >
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold text-text-primary">
                  Iris vs {item.name}
                </h2>
                <span className="text-xs rounded-full bg-surface-secondary px-2 py-0.5 text-text-secondary">
                  {item.category}
                </span>
              </div>
              <p className="text-sm text-text-secondary">{item.tagline}</p>
            </Link>
          ))}
        </div>

        <div className="mt-12 rounded-xl border border-border-default bg-surface-primary p-8">
          <h2 className="text-lg font-semibold text-text-primary mb-3">
            Why Iris is different
          </h2>
          <ul className="space-y-2 text-text-secondary text-sm">
            <li>
              <span className="font-medium text-text-primary">MCP-native</span>{" "}
              — Iris runs as an MCP server. No SDK, no code changes, no vendor lock-in.
            </li>
            <li>
              <span className="font-medium text-text-primary">Heuristic-first</span>{" "}
              — Deterministic rules run on every output. No LLM-as-judge costs or latency.
            </li>
            <li>
              <span className="font-medium text-text-primary">Quality + Safety + Cost</span>{" "}
              — Three dimensions scored together. Not just quality, not just safety.
            </li>
            <li>
              <span className="font-medium text-text-primary">Self-hosted</span>{" "}
              — Your data stays on your machine. Free forever for the open-source core.
            </li>
          </ul>
        </div>
      </main>
      <Footer />
    </>
  );
}
