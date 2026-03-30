import type { Metadata } from "next";
import Link from "next/link";
import { SectionHeading } from "@/components/learn/section-heading";
import { CalloutBox } from "@/components/learn/callout-box";
import { VocabularyCard } from "@/components/learn/vocabulary-card";
import { FaqSection } from "@/components/learn/faq-section";
import { TableOfContents } from "@/components/learn/table-of-contents";

export const metadata: Metadata = {
  title: "Eval-Driven Development: Write the Rules Before the Prompt — Iris",
  description: "What is Eval-Driven Development (EDD)? The practice of defining evaluation rules before writing agent prompts — TDD for AI agents.",
  alternates: { canonical: "https://iris-eval.com/learn/eval-driven-development" },
  openGraph: { title: "Eval-Driven Development: Write the Rules Before the Prompt", description: "TDD for AI agents — define eval rules before prompts.", url: "https://iris-eval.com/learn/eval-driven-development", type: "article", images: ["/og-social-preview.png?v=3"] },
  twitter: { card: "summary_large_image", title: "Eval-Driven Development (EDD)", description: "TDD for AI agents — define eval rules before prompts.", images: ["/og-social-preview.png?v=3"], site: "@iris_eval" },
};

function s(value: unknown): string { return String(value ?? "").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").slice(0, 500); }

const FAQ_ITEMS = [
  { question: "What is Eval-Driven Development?", answer: "Eval-Driven Development (EDD) is the practice of defining evaluation rules before writing agent prompts — the same way test-driven development defines tests before writing code. You specify what 'correct' looks like first, then build the agent to pass those rules." },
  { question: "How is EDD different from TDD?", answer: "TDD asserts exact outputs: given input X, expect output Y. EDD scores outputs on dimensions: completeness above 0.7, no PII detected, cost under $0.05. Agent outputs are non-deterministic, so exact-match assertions don't work. EDD uses scoring rules instead." },
  { question: "What are the benefits of EDD?", answer: "Three main benefits: (1) you define success criteria before building, preventing scope creep; (2) every prompt iteration is measurable — you know if changes improved or degraded quality; (3) eval rules survive the entire lifecycle from development through production." },
];

const TOC_ITEMS = [
  { id: "definition", label: "Definition", level: 2 as const },
  { id: "the-edd-cycle", label: "The EDD Cycle", level: 2 as const },
  { id: "edd-vs-tdd", label: "EDD vs TDD", level: 2 as const },
  { id: "how-iris-helps", label: "How Iris Helps", level: 2 as const },
  { id: "related-concepts", label: "Related Concepts", level: 2 as const },
  { id: "faq", label: "FAQ", level: 2 as const },
];

const jsonLd = { "@context": "https://schema.org", "@graph": [
  { "@type": "Article", headline: s("Eval-Driven Development: Write the Rules Before the Prompt"), description: s("The practice of defining evaluation rules before writing agent prompts — TDD for AI agents."), url: "https://iris-eval.com/learn/eval-driven-development", datePublished: "2026-03-30", dateModified: "2026-03-30", author: { "@type": "Person", name: "Ian Parent", url: "https://x.com/iparentx" }, publisher: { "@type": "Organization", name: "Iris", url: "https://iris-eval.com" }, mainEntityOfPage: "https://iris-eval.com/learn/eval-driven-development" },
  { "@type": "FAQPage", mainEntity: FAQ_ITEMS.map((item) => ({ "@type": "Question", name: s(item.question), acceptedAnswer: { "@type": "Answer", text: s(item.answer) } })) },
  { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: "https://iris-eval.com" }, { "@type": "ListItem", position: 2, name: "Learn", item: "https://iris-eval.com/learn" }, { "@type": "ListItem", position: 3, name: "Eval-Driven Development" }] },
]};

export default function LearnEDD(): React.ReactElement {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="mx-auto max-w-6xl px-6 pt-32 pb-20 lg:pt-40">
        <div className="lg:grid lg:grid-cols-[1fr_240px] lg:gap-16">
        <article className="max-w-3xl text-[15px] leading-[1.8] text-text-secondary">
        <nav className="mb-8 text-sm text-text-muted">
          <Link href="/" className="hover:text-text-secondary transition-colors">Home</Link><span className="mx-2">/</span>
          <Link href="/learn" className="hover:text-text-secondary transition-colors">Learn</Link><span className="mx-2">/</span>
          <span className="text-text-primary">Eval-Driven Development</span>
        </nav>

        <h1 className="font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">Eval-Driven Development</h1>
        <p className="mt-4 text-lg text-text-secondary max-w-2xl">Write the rules before the prompt. TDD for AI agents.</p>

        <SectionHeading id="definition" level={2}>Definition</SectionHeading>
        <CalloutBox variant="definition">
          <strong>Eval-Driven Development (EDD)</strong> is the practice of defining evaluation rules before writing agent prompts — the same way test-driven development defines tests before writing code. You specify what &quot;correct&quot; looks like first, then build the agent to pass those rules. Every prompt iteration is measurable.
        </CalloutBox>

        <SectionHeading id="the-edd-cycle" level={2}>The EDD Cycle</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-4">
          <div className="rounded-lg border border-border-default bg-surface-primary p-5 text-center">
            <div className="text-2xl font-bold text-iris-400 mb-2">1</div>
            <h3 className="font-semibold text-text-primary mb-1">Define Rules</h3>
            <p className="text-xs text-text-secondary">What does &quot;correct&quot; look like? Set thresholds for quality, safety, cost.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5 text-center">
            <div className="text-2xl font-bold text-iris-400 mb-2">2</div>
            <h3 className="font-semibold text-text-primary mb-1">Write Prompt</h3>
            <p className="text-xs text-text-secondary">Build the agent prompt to meet the rules you defined.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5 text-center">
            <div className="text-2xl font-bold text-iris-400 mb-2">3</div>
            <h3 className="font-semibold text-text-primary mb-1">Score Outputs</h3>
            <p className="text-xs text-text-secondary">Run the agent. Eval rules score every output automatically.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5 text-center">
            <div className="text-2xl font-bold text-iris-400 mb-2">4</div>
            <h3 className="font-semibold text-text-primary mb-1">Iterate</h3>
            <p className="text-xs text-text-secondary">Refine prompts based on scores. Repeat until rules pass consistently.</p>
          </div>
        </div>

        <SectionHeading id="edd-vs-tdd" level={2}>EDD vs TDD</SectionHeading>
        <div className="mt-6 overflow-x-auto rounded-2xl border border-border-default bg-bg-card">
          <table className="w-full text-left text-[14px]">
            <thead><tr className="border-b border-border-default">
              <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-text-muted">Dimension</th>
              <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-text-accent">TDD</th>
              <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-iris-400">EDD</th>
            </tr></thead>
            <tbody>
              <tr className="border-b border-border-subtle"><td className="px-6 py-3 font-semibold text-text-primary">Assertion type</td><td className="px-6 py-3 text-text-secondary">Exact match</td><td className="px-6 py-3 text-text-secondary">Score threshold</td></tr>
              <tr className="border-b border-border-subtle"><td className="px-6 py-3 font-semibold text-text-primary">Output model</td><td className="px-6 py-3 text-text-secondary">Deterministic</td><td className="px-6 py-3 text-text-secondary">Non-deterministic</td></tr>
              <tr className="border-b border-border-subtle"><td className="px-6 py-3 font-semibold text-text-primary">Runs in prod?</td><td className="px-6 py-3 text-text-secondary">No (CI only)</td><td className="px-6 py-3 text-text-secondary">Yes (every output)</td></tr>
              <tr><td className="px-6 py-3 font-semibold text-text-primary">What you define first</td><td className="px-6 py-3 text-text-secondary">Test cases</td><td className="px-6 py-3 text-text-secondary">Eval rules</td></tr>
            </tbody>
          </table>
        </div>

        <SectionHeading id="how-iris-helps" level={2}>How Iris Helps</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          Iris makes EDD practical. Define your eval rules, add Iris to your MCP config, and every agent output is scored against those rules automatically. The same rules that guide development continue running in production — no separate test harness needed.
        </p>
        <p className="mt-6 text-text-secondary"><Link href="/blog/eval-driven-development" className="text-iris-400 hover:text-iris-300 transition-colors">Read the deep dive: Eval-Driven Development &rarr;</Link></p>

        <SectionHeading id="related-concepts" level={2}>Related Concepts</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <VocabularyCard term="Eval Coverage" definition="EDD naturally produces 100% coverage — rules run on every output." href="/learn/eval-coverage" />
          <VocabularyCard term="The Eval Loop" definition="EDD is the starting point. The eval loop is what happens next — continuous iteration." href="/learn/eval-loop" />
          <VocabularyCard term="The Eval Gap" definition="EDD closes the gap by ensuring production uses the same rules as development." href="/learn/eval-gap" />
          <VocabularyCard term="Agent Eval" definition="The complete guide to evaluating AI agent outputs." href="/learn/agent-eval" />
        </div>

        <SectionHeading id="faq" level={2}>Frequently Asked Questions</SectionHeading>
        <FaqSection items={FAQ_ITEMS} />
        </article>
        <aside className="hidden lg:block">
          <TableOfContents items={TOC_ITEMS} />
        </aside>
        </div>
      </div>
    </>
  );
}
