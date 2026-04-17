import { readFileSync, readdirSync } from "fs";
import { join } from "path";

export interface BlogPost {
  slug: string;
  title: string;
  date: string;
  author: string;
  tags: string[];
  description: string;
  content: string;
  filename: string;
  published: boolean;
  relatedPosts?: string[];
}

const BLOG_DIR = join(process.cwd(), "..", "docs", "blog");

function parseFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  content: string;
} {
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

  // Remove the H1 title if it duplicates the frontmatter title
  let content = match[2].trim();
  const firstLine = content.split("\n")[0];
  if (firstLine.startsWith("# ") && meta.title && firstLine.slice(2).trim() === (meta.title as string).replace(/"/g, "")) {
    content = content.slice(firstLine.length).trim();
  }

  return { meta, content };
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

      return {
        slug: filenameToSlug(filename),
        title: (meta.title as string) || filename,
        date: (meta.date as string) || "2026-03-17",
        author: (meta.author as string) || "Ian Parent",
        tags: (meta.tags as string[]) || [],
        description: (meta.description as string) || extractDescription(content),
        content,
        filename,
        published: meta.published !== false,
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
