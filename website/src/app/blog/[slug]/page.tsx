import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { getAllPosts, getPostBySlug } from "@/lib/blog";

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
    openGraph: {
      title: post.title,
      description: post.description,
      url: `https://iris-eval.com/blog/${post.slug}`,
      type: "article",
      publishedTime: String(post.date),
      authors: [post.author],
      images: ["/og-social-preview.png"],
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
      images: ["/og-social-preview.png"],
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

  return (
    <>
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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {post.content}
          </ReactMarkdown>
        </div>

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
