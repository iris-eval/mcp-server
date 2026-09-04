import type { MetadataRoute } from "next";
import { getAllPosts } from "@/lib/blog";
import { PAGE_LAST_MODIFIED, type StaticRoute } from "@/lib/page-dates";

// Regenerate hourly so future-dated posts enter the sitemap on schedule.
export const revalidate = 3600;

const baseUrl = "https://iris-eval.com";

type Entry = MetadataRoute.Sitemap[number];
type ChangeFrequency = Entry["changeFrequency"];

// Every lastmod below is a real edit date. Static pages read
// src/lib/page-dates.ts (generated from git — see the header there for how
// to refresh it); blog posts carry `updated:` in their frontmatter, falling
// back to the publish date. This used to be `new Date()` on every static
// entry, which told crawlers that every page changed on every deploy —
// indistinguishable from never changing at all.
function page(
  route: StaticRoute,
  changeFrequency: ChangeFrequency,
  priority: number,
  lastModified: string = PAGE_LAST_MODIFIED[route],
): Entry {
  return {
    url: route === "/" ? baseUrl : `${baseUrl}${route}`,
    lastModified,
    changeFrequency,
    priority,
  };
}

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllPosts();

  const blogEntries: MetadataRoute.Sitemap = posts.map((post) => ({
    url: `${baseUrl}/blog/${post.slug}`,
    lastModified: post.updated,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  // The index changes whenever a post does.
  const blogIndexModified = posts.reduce<string>(
    (max, post) => (post.updated > max ? post.updated : max),
    PAGE_LAST_MODIFIED["/blog"],
  );

  const comparePages = [
    "langfuse",
    "langsmith",
    "helicone",
    "braintrust",
    "arize",
    "deepeval",
    "confident-ai",
    "patronus-ai",
  ] as const;

  const compareEntries = comparePages.map((slug) =>
    page(`/compare/${slug}`, "monthly", 0.6),
  );

  const learnTerms = [
    "eval-tax",
    "eval-drift",
    "eval-gap",
    "eval-coverage",
    "eval-driven-development",
    "eval-loop",
    "self-calibrating-eval",
    "output-quality-score",
  ] as const;

  const learnTermEntries = learnTerms.map((term) =>
    page(`/learn/${term}`, "monthly", 0.85),
  );

  return [
    page("/learn", "weekly", 0.85),
    page("/learn/agent-eval", "weekly", 0.95),
    ...learnTermEntries,
    page("/", "weekly", 1),
    page("/playground", "weekly", 0.9),
    page("/playground/live", "weekly", 0.9),
    page("/proof", "monthly", 0.85),
    page("/pricing", "monthly", 0.85),
    page("/blog", "daily", 0.8, blogIndexModified),
    ...blogEntries,
    page("/compare", "weekly", 0.7),
    ...compareEntries,
    page("/privacy", "yearly", 0.3),
    page("/terms", "yearly", 0.3),
    page("/security", "monthly", 0.5),
  ];
}
