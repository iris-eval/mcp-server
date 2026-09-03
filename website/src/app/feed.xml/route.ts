import { getAllPosts } from "@/lib/blog";
import { FEED_TITLE, FEED_URL } from "@/lib/feed";

// Regenerate hourly, like the sitemap and the blog index, so date-scheduled
// posts enter the feed on schedule without a redeploy.
export const revalidate = 3600;

const SITE_URL = "https://iris-eval.com";

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      default:
        return "&quot;";
    }
  });
}

// RSS 2.0 wants RFC 822 dates; frontmatter dates are ISO days, read as UTC.
function rfc822(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toUTCString();
}

export function GET(): Response {
  const posts = getAllPosts();

  // The feed changes whenever any post is published or revised; with no
  // posts at all, "now" is the only honest answer.
  const lastChange = posts.reduce(
    (max, post) => (post.updated > max ? post.updated : max),
    posts[0]?.updated ?? new Date().toISOString().slice(0, 10),
  );

  const items = posts
    .map((post) => {
      const url = `${SITE_URL}/blog/${post.slug}`;
      const categories = post.tags
        .map((tag) => `      <category>${escapeXml(tag)}</category>`)
        .join("\n");
      return [
        "    <item>",
        `      <title>${escapeXml(post.title)}</title>`,
        `      <link>${url}</link>`,
        `      <guid isPermaLink="true">${url}</guid>`,
        `      <pubDate>${rfc822(post.date)}</pubDate>`,
        `      <dc:creator>${escapeXml(post.author)}</dc:creator>`,
        // The summary, not the body: the canonical text lives on the page.
        `      <description>${escapeXml(post.description)}</description>`,
        categories,
        "    </item>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeXml(FEED_TITLE)}</title>
    <link>${SITE_URL}/blog</link>
    <description>Original research and insights on MCP agent observability, evaluation methodology, and AI agent infrastructure.</description>
    <language>en-us</language>
    <lastBuildDate>${rfc822(lastChange)}</lastBuildDate>
    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
