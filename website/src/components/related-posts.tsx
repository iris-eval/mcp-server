import Link from "next/link";
import type { BlogPost } from "@/lib/blog";

interface RelatedPostsProps {
  posts: BlogPost[];
}

export function RelatedPosts({ posts }: RelatedPostsProps) {
  if (posts.length === 0) return null;

  return (
    <div className="mt-16">
      <h3 className="font-display text-xl font-semibold text-text-primary mb-6">
        Continue Reading
      </h3>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {posts.map((post) => (
          <Link
            key={post.slug}
            href={`/blog/${post.slug}`}
            className="rounded-lg border border-border-default bg-surface-primary p-5 transition-colors hover:border-iris-500/40"
          >
            <h4 className="font-semibold text-text-primary mb-1 text-[15px]">
              {post.title}
            </h4>
            <p className="text-sm text-text-secondary line-clamp-2">
              {post.description}
            </p>
          </Link>
        ))}
      </div>
      <div className="mt-6 text-center">
        <Link
          href="/learn"
          className="text-sm text-iris-400 hover:text-iris-300 transition-colors"
        >
          Explore the full agent eval vocabulary &rarr;
        </Link>
      </div>
    </div>
  );
}
