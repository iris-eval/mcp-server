import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OG_IMAGE_URL } from "@/lib/og";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { getAllPosts, getPostBySlug } from "@/lib/blog";
import { RelatedPosts } from "@/components/related-posts";

/** Sanitize a string for safe inclusion in JSON-LD structured data. */
function sanitizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .slice(0, 500);
}

export function generateStaticParams(): { slug: string }[] {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) return {};

  return {
    title: `${post.title} — Iris`,
    description: post.description,
    alternates: {
      canonical: `https://iris-eval.com/blog/${slug}`,
    },
    openGraph: {
      title: post.title,
      description: post.description,
      url: `https://iris-eval.com/blog/${post.slug}`,
      type: "article",
      publishedTime: String(post.date),
      authors: [post.author],
      images: [OG_IMAGE_URL],
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
      images: [OG_IMAGE_URL],
      site: "@iris_eval",
    },
  };
}

export default async function BlogPost({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactElement> {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) notFound();

  const blogPostJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: sanitizeText(post.title),
    datePublished: sanitizeText(post.date),
    dateModified: sanitizeText(post.date),
    author: {
      "@type": "Person",
      name: sanitizeText(post.author),
      url: "https://x.com/iparentx",
    },
    publisher: {
      "@type": "Organization",
      name: "Iris",
      url: "https://iris-eval.com",
    },
    description: sanitizeText(post.description),
    articleBody: sanitizeText(post.content.slice(0, 1000)),
    mainEntityOfPage: `https://iris-eval.com/blog/${encodeURIComponent(slug)}`,
  });

  // FAQ schema for coined vocabulary terms — targets featured snippets
  const vocabularyFAQ: Record<string, { question: string; answer: string }[]> = {
    "the-ai-eval-tax": [
      {
        question: "What is the AI eval tax?",
        answer: "The AI eval tax is the compounding cost of every agent output you did not evaluate. It manifests as customer trust erosion, engineering hours spent on manual review, liability exposure from undetected hallucinations, and revenue loss from agents that silently degrade in production. Teams pay this tax every time an agent returns a wrong answer and nobody catches it."
      },
    ],
    "eval-drift-the-silent-quality-killer": [
      {
        question: "What is eval drift?",
        answer: "Eval drift is the silent degradation of AI agent output quality over time, caused by upstream changes that are invisible to the team operating the agent. When model providers update weights, safety filters, or decoding parameters without announcement, agents that passed evaluation last month may be shipping broken outputs today. Eval drift is only detectable through continuous scoring on every agent execution."
      },
    ],
    "the-eval-gap": [
      {
        question: "What is the eval gap?",
        answer: "The eval gap is the distance between having observability (knowing your agent ran) and having inline evaluation (knowing the output was correct). Industry data shows 89% of teams have observability but only 37% have inline eval, creating a 52-point gap where agents appear healthy on dashboards while silently delivering poor-quality outputs to users."
      },
    ],
    "the-eval-loop": [
      {
        question: "What is the eval loop?",
        answer: "The eval loop is a continuous feedback cycle for agent quality: score every output, diagnose which specific rules are failing, calibrate thresholds based on production data, then re-score. Unlike one-time evaluation that happens before deployment, the eval loop runs for the lifetime of the agent, treating evals as a feedback signal rather than a gate."
      },
    ],
  };

  const faqItems = vocabularyFAQ[slug];
  const faqJsonLd = faqItems
    ? JSON.stringify({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: faqItems.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: item.answer,
          },
        })),
      })
    : null;

  const breadcrumbJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://iris-eval.com" },
      { "@type": "ListItem", position: 2, name: "Blog", item: "https://iris-eval.com/blog" },
      { "@type": "ListItem", position: 3, name: sanitizeText(post.title) },
    ],
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: blogPostJsonLd }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: breadcrumbJsonLd }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: faqJsonLd }}
        />
      )}
      <Nav />

      <article className="mx-auto max-w-3xl px-6 pb-16 pt-32 lg:pt-40">
        {/* Header */}
        <div className="mb-10">
          <a
            href="/blog"
            className="inline-flex items-center gap-1.5 text-[13px] text-text-muted transition-colors hover:text-text-accent"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            All posts
          </a>
          <h1 className="mt-6 font-display text-3xl font-extrabold tracking-tight text-text-primary md:text-4xl lg:text-5xl">
            {post.title}
          </h1>
          <div className="mt-4 flex items-center gap-3 text-[13px] text-text-muted">
            <time dateTime={String(post.date)}>
              {new Date(String(post.date)).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </time>
            <span className="text-border-default">&middot;</span>
            <span>{post.author}</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {post.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-iris-600/8 px-2.5 py-0.5 text-[11px] font-medium text-text-accent"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="prose-iris">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {post.content}
          </ReactMarkdown>
        </div>

        {/* Related Posts */}
        {post.relatedPosts && post.relatedPosts.length > 0 && (() => {
          const related = post.relatedPosts
            .map((slug) => getPostBySlug(slug))
            .filter((p): p is NonNullable<typeof p> => p != null);
          return related.length > 0 ? <RelatedPosts posts={related} /> : null;
        })()}

        {/* Waitlist CTA */}
        <div className="mt-16 rounded-2xl border border-border-glow bg-bg-card p-8 text-center">
          <h3 className="font-display text-xl font-bold text-text-primary">
            See what your agents are actually doing
          </h3>
          <p className="mt-3 text-[14px] text-text-secondary">
            Add Iris to your MCP config. First trace in 60 seconds. No SDK, no signup.
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="https://github.com/iris-eval/mcp-server"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-iris-600 px-6 py-3 text-[14px] font-semibold text-white shadow-sm shadow-iris-600/20 transition-all hover:bg-iris-500"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
              Get Started
            </a>
            <a
              href="/#waitlist"
              className="inline-flex items-center rounded-xl border border-border-default px-6 py-3 text-[14px] font-semibold text-text-secondary transition-all hover:border-border-glow hover:text-text-primary"
            >
              Join Cloud Waitlist
            </a>
          </div>
        </div>
      </article>

      <Footer />
    </>
  );
}
