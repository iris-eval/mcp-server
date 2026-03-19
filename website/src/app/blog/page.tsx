import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { getAllPosts } from "@/lib/blog";

export const metadata: Metadata = {
  title: "Blog — Iris",
  description:
    "Original research and insights on MCP agent observability, evaluation methodology, and AI agent infrastructure.",
  openGraph: {
    title: "Blog — Iris",
    description:
      "Research and insights on MCP agent observability and evaluation.",
    url: "https://iris-eval.com/blog",
    images: ["/og-social-preview.png?v=3"],
  },
};

export default function BlogIndex(): React.ReactElement {
  const posts = getAllPosts();

  return (
    <>
      <Nav />

      <section className="relative bg-bg-base pb-12 pt-32 lg:pt-40">
        <div className="glow-hero absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-20" aria-hidden="true" />
        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
            Blog
          </p>
          <h1 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">
            Research &amp; insights
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-text-secondary">
            Original research on MCP agent observability, evaluation
            methodology, and the evolving landscape of AI agent infrastructure.
          </p>
        </div>
      </section>

      <section className="bg-bg-base pb-20">
        <div className="mx-auto max-w-4xl px-6">
          <div className="space-y-6">
            {posts.map((post) => (
              <a
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="group block rounded-2xl border border-border-default bg-bg-card p-8 transition-all hover:border-border-glow hover:shadow-lg hover:shadow-iris-600/5"
              >
                <div className="flex items-center gap-3 text-[12px] text-text-muted">
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
                <h2 className="mt-3 font-display text-xl font-bold text-text-primary transition-colors group-hover:text-text-accent md:text-2xl">
                  {post.title}
                </h2>
                <p className="mt-3 text-[14px] leading-relaxed text-text-secondary">
                  {post.description}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {post.tags.slice(0, 4).map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-iris-600/8 px-2.5 py-0.5 text-[11px] font-medium text-text-accent"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
