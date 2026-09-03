import { readFileSync, readdirSync } from "fs";
import { join } from "path";

export interface BlogPost {
  slug: string;
  title: string;
  date: string;
  /** Last content edit (ISO day). Equals `date` for a post never revised. */
  updated: string;
  author: string;
  tags: string[];
  description: string;
  /**
   * Optional search-snippet overrides. The on-page H1 and the OG card keep
   * `title` / `description`; these feed only the <title> tag and the meta
   * description, so a long editorial title can stay long while the tag a
   * search engine truncates at ~60 chars gets a short form (see
   * app/blog/[slug]/page.tsx).
   */
  seoTitle?: string;
  seoDescription?: string;
  content: string;
  filename: string;
  published: boolean;
  relatedPosts?: string[];
}

const BLOG_DIR = join(process.cwd(), "..", "docs", "blog");

function parseFrontmatter(input: string): {
  meta: Record<string, unknown>;
  content: string;
} {
  // A Windows checkout (core.autocrlf) hands us CRLF files; the delimiter
  // regex below is LF-only, and a miss here silently turns the post's title
  // into its filename and renders the body H1 twice. Normalise first so a
  // local build on Windows produces the same pages as the Linux deploy.
  const raw = input.replace(/\r\n/g, "\n");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, content: raw };

  const meta: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Parse arrays like [a, b, c]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim());
    }
    // Strip quotes
    if (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }

  return { meta, content: stripBodyH1(match[2]) };
}

// The page renders its own <h1> from the frontmatter title, so the body's
// `# ` heading has to go. It is not always the first line: six posts open
// with an editor's-note blockquote above it, and a first-line-only check let
// every one of those render two H1s. Remove the first ATX H1 wherever it
// sits — but never inside a fenced code block, where `# ` is a shell
// comment (post 001 has `# Open http://localhost:6920` in a ```bash block).
function stripBodyH1(body: string): string {
  const lines = body.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^# /.test(lines[i])) {
      lines.splice(i, 1);
      break;
    }
  }
  return lines.join("\n").trim();
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function optionalString(value: unknown): string | undefined {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : undefined;
}

function extractDescription(content: string): string {
  // First non-empty paragraph
  const lines = content.split("\n\n");
  for (const line of lines) {
    const clean = line.replace(/[#*`>\[\]]/g, "").trim();
    if (clean.length > 40) {
      return clean.slice(0, 160) + (clean.length > 160 ? "..." : "");
    }
  }
  return "";
}

function filenameToSlug(filename: string): string {
  // 003-why-every-mcp-agent-needs-an-independent-observer.md → independent-observer
  // Use the full descriptive part after the number prefix
  // Sanitize to URL-safe characters only (alphanumeric, hyphens)
  return filename
    .replace(/^\d+-/, "")
    .replace(/\.md$/, "")
    .replace(/[^a-zA-Z0-9-]/g, "");
}

export function getAllPosts(): BlogPost[] {
  const files = readdirSync(BLOG_DIR)
    .filter((f) => f.endsWith(".md") && !f.startsWith(".") && /^\d{3}-/.test(f));

  const now = new Date();

  return files
    .map((filename) => {
      const raw = readFileSync(join(BLOG_DIR, filename), "utf8");
      const { meta, content } = parseFrontmatter(raw);
      const date = (meta.date as string) || "2026-03-17";
      // `updated:` is the author's record of the last content edit. It feeds
      // JSON-LD dateModified, the sitemap and the feed; without it every
      // post claimed to be untouched since the day it was published.
      const updated = String(meta.updated ?? "").trim();

      return {
        slug: filenameToSlug(filename),
        title: (meta.title as string) || filename,
        date,
        updated: ISO_DAY.test(updated) && updated > date ? updated : date,
        author: (meta.author as string) || "Ian Parent",
        tags: (meta.tags as string[]) || [],
        description: (meta.description as string) || extractDescription(content),
        seoTitle: optionalString(meta.seoTitle),
        seoDescription: optionalString(meta.seoDescription),
        content,
        filename,
        // parseFrontmatter yields STRINGS, so `meta.published` is the string
        // "false", never the boolean — `!== false` was therefore always true
        // and this gate has never withheld anything. A post written with
        // `published: false` rendered live on the site. Compare the parsed
        // form instead.
        published: String(meta.published ?? "true").trim().toLowerCase() !== "false",
        relatedPosts: (meta.relatedPosts as string[]) || undefined,
      };
    })
    .filter((post) => {
      if (!post.published) return false;
      const postDate = new Date(post.date);
      return postDate <= now;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export function getPostBySlug(slug: string): BlogPost | undefined {
  return getAllPosts().find((p) => p.slug === slug);
}
