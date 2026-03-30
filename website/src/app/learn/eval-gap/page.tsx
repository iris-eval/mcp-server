import type { Metadata } from "next";
import Link from "next/link";
import { SectionHeading } from "@/components/learn/section-heading";
import { CalloutBox } from "@/components/learn/callout-box";
import { VocabularyCard } from "@/components/learn/vocabulary-card";
import { FaqSection } from "@/components/learn/faq-section";
import { TableOfContents } from "@/components/learn/table-of-contents";

export const metadata: Metadata = {
  title: "The Eval Gap: Why Your AI Demo Works and Production Doesn't — Iris",
  description:
    "What is the eval gap? The distance between demo performance and production reality. Learn the four mechanisms that create it and how inline evaluation closes it.",
  alternates: { canonical: "https://iris-eval.com/learn/eval-gap" },
  openGraph: {
    title: "The Eval Gap: Why Your AI Demo Works and Production Doesn't",
    description: "The distance between demo performance and production reality.",
    url: "https://iris-eval.com/learn/eval-gap",
    type: "article",
    images: ["/og-social-preview.png?v=3"],
  },
  twitter: { card: "summary_large_image", title: "The Eval Gap", description: "Why your AI demo works and production doesn't.", images: ["/og-social-preview.png?v=3"], site: "@iris_eval" },
};

function s(value: unknown): string {
  return String(value ?? "").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").slice(0, 500);
}

const FAQ_ITEMS = [
  { question: "What is the eval gap?", answer: "The eval gap is the difference between how an AI agent performs in demos and development versus how it performs in production with real users, real data, and real edge cases. It's the distance between 'it works on my machine' and 'it works for our customers.'" },
  { question: "Why does the eval gap exist?", answer: "Four mechanisms: (1) curated demo inputs vs messy real inputs, (2) controlled environment vs production variability, (3) small sample size vs scale effects, (4) implicit human oversight during demos that doesn't exist in production." },
  { question: "How do you close the eval gap?", answer: "By running the same evaluation in production that you run in development — on every output, not just test cases. When eval is inline and continuous, production performance is visible in real-time, and the gap between demo and reality becomes measurable and addressable." },
];

const TOC_ITEMS = [
  { id: "definition", label: "Definition", level: 2 as const },
  { id: "four-mechanisms", label: "Four Mechanisms", level: 2 as const },
  { id: "closing-the-gap", label: "Closing the Gap", level: 2 as const },
  { id: "how-iris-helps", label: "How Iris Helps", level: 2 as const },
  { id: "related-concepts", label: "Related Concepts", level: 2 as const },
  { id: "faq", label: "FAQ", level: 2 as const },
];

const jsonLd = { "@context": "https://schema.org", "@graph": [
  { "@type": "Article", headline: s("The Eval Gap: Why Your AI Demo Works and Production Doesn't"), description: s("The distance between demo performance and production reality."), url: "https://iris-eval.com/learn/eval-gap", datePublished: "2026-03-30", dateModified: "2026-03-30", author: { "@type": "Person", name: "Ian Parent", url: "https://x.com/iparentx" }, publisher: { "@type": "Organization", name: "Iris", url: "https://iris-eval.com" }, mainEntityOfPage: "https://iris-eval.com/learn/eval-gap" },
  { "@type": "FAQPage", mainEntity: FAQ_ITEMS.map((item) => ({ "@type": "Question", name: s(item.question), acceptedAnswer: { "@type": "Answer", text: s(item.answer) } })) },
  { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: "https://iris-eval.com" }, { "@type": "ListItem", position: 2, name: "Learn", item: "https://iris-eval.com/learn" }, { "@type": "ListItem", position: 3, name: "The Eval Gap" }] },
]};

export default function LearnEvalGap(): React.ReactElement {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="relative mx-auto max-w-4xl px-6 pt-32 pb-20 lg:pt-40">
        <TableOfContents items={TOC_ITEMS} />
        <nav className="mb-8 text-sm text-text-muted">
          <Link href="/" className="hover:text-text-secondary transition-colors">Home</Link><span className="mx-2">/</span>
          <Link href="/learn" className="hover:text-text-secondary transition-colors">Learn</Link><span className="mx-2">/</span>
          <span className="text-text-primary">The Eval Gap</span>
        </nav>

        <h1 className="font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">The Eval Gap</h1>
        <p className="mt-4 text-lg text-text-secondary max-w-2xl">Why your AI demo works and production doesn&apos;t — and how to close the distance.</p>

        <SectionHeading id="definition" level={2}>Definition</SectionHeading>
        <CalloutBox variant="definition">
          <strong>The eval gap</strong> is the difference between how an AI agent performs in demos and development versus how it performs in production. Curated inputs, controlled environments, small sample sizes, and implicit human oversight during development create an illusion of reliability that evaporates under real-world conditions.
        </CalloutBox>

        <SectionHeading id="four-mechanisms" level={2}>Four Mechanisms That Create the Gap</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Curated Inputs</h3>
            <p className="text-sm text-text-secondary">Demos use carefully chosen examples. Production receives whatever users send — typos, edge cases, adversarial inputs, languages you didn&apos;t test.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Controlled Environment</h3>
            <p className="text-sm text-text-secondary">Development has fast APIs, unlimited rate limits, and the latest model. Production has latency spikes, rate limiting, and model versions you don&apos;t control.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Small Sample Size</h3>
            <p className="text-sm text-text-secondary">10 demo runs look great. 10,000 production runs reveal the long tail of failures that sampling never catches.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Implicit Oversight</h3>
            <p className="text-sm text-text-secondary">During demos, humans review every output. In production, agents run autonomously. The human safety net disappears.</p>
          </div>
        </div>

        <SectionHeading id="closing-the-gap" level={2}>Closing the Gap</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          The eval gap closes when you run the same evaluation in production that you run in development — on every output, not just test cases. Inline eval makes production performance visible in real-time. The gap between demo and reality becomes measurable, and measurable problems are solvable.
        </p>

        <SectionHeading id="how-iris-helps" level={2}>How Iris Helps</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          Iris evaluates every production output with the same rules you define in development. No gap between test-time scoring and production scoring — same rules, same thresholds, every execution. The dashboard shows you production quality in real-time, making the eval gap visible and quantifiable.
        </p>
        <p className="mt-6 text-text-secondary"><Link href="/blog/the-eval-gap" className="text-iris-400 hover:text-iris-300 transition-colors">Read the deep dive: The Eval Gap &rarr;</Link></p>

        <SectionHeading id="related-concepts" level={2}>Related Concepts</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <VocabularyCard term="The Eval Tax" definition="The eval gap is where the eval tax accumulates fastest." href="/learn/eval-tax" />
          <VocabularyCard term="Eval-Driven Development" definition="Define eval rules before prompts — closes the gap by design." href="/learn/eval-driven-development" />
          <VocabularyCard term="Eval Coverage" definition="100% coverage means no output goes unscored — the gap becomes visible." href="/learn/eval-coverage" />
          <VocabularyCard term="Agent Eval" definition="The complete guide to evaluating AI agent outputs." href="/learn/agent-eval" />
        </div>

        <SectionHeading id="faq" level={2}>Frequently Asked Questions</SectionHeading>
        <FaqSection items={FAQ_ITEMS} />
      </div>
    </>
  );
}
