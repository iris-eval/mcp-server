#!/usr/bin/env node

/**
 * Dev.to Cross-Post Automation
 *
 * Reads all blog posts from docs/blog/, formats them for Dev.to,
 * and creates or updates them via the Dev.to API.
 *
 * Requires: DEVTO_API_KEY environment variable
 *
 * How it works:
 * - Reads each docs/blog/0*.md file
 * - Parses YAML frontmatter for title, tags, date
 * - Generates slug and canonical_url pointing to iris-eval.com
 * - Checks if the post already exists on Dev.to (by canonical_url)
 * - Creates new posts or updates existing ones
 * - All posts are added to the "MCP Agent Observability" series
 *
 * To add to the automation: just create a new docs/blog/0XX-*.md file
 * with proper frontmatter. The script handles everything else.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const API_KEY = process.env.DEVTO_API_KEY;
if (!API_KEY) {
  console.error("DEVTO_API_KEY not set. Skipping cross-post.");
  process.exit(0);
}

const BLOG_DIR = join(process.cwd(), "docs", "blog");
const SERIES = "MCP Agent Observability";
const BASE_URL = "https://iris-eval.com/blog";

// Dev.to allows max 4 tags
const DEFAULT_TAGS = ["mcp", "aiagents", "observability", "opensource"];

function parseFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const meta = {};
  for (const line of match[1].split("\n")) {
    const ci = line.indexOf(":");
    if (ci === -1) continue;
    const key = line.slice(0, ci).trim();
    let val = line.slice(ci + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map((s) => s.trim());
    }
    meta[key] = val;
  }

  // Remove H1 if it duplicates the title
  let content = match[2].trim();
  const firstLine = content.split("\n")[0];
  if (firstLine.startsWith("# ")) {
    content = content.slice(firstLine.length).trim();
  }

  return { meta, content };
}

function filenameToSlug(filename) {
  return filename.replace(/^\d+-/, "").replace(/\.md$/, "");
}

async function devtoRequest(method, path, body) {
  const res = await fetch(`https://dev.to/api${path}`, {
    method,
    headers: {
      "api-key": API_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dev.to API ${method} ${path}: ${res.status} ${text}`);
  }

  return res.json();
}

async function getExistingArticles() {
  // Fetch all published articles for this user
  const articles = await devtoRequest("GET", "/articles/me/all?per_page=100");
  return articles;
}

async function main() {
  console.log("Cross-posting blog posts to Dev.to...\n");

  // Get all existing Dev.to articles to check for duplicates
  const existing = await getExistingArticles();
  const existingByCanonical = new Map();
  for (const article of existing) {
    if (article.canonical_url) {
      existingByCanonical.set(article.canonical_url, article);
    }
  }

  // Read all blog posts
  const files = readdirSync(BLOG_DIR)
    .filter((f) => f.endsWith(".md") && /^\d{3}-/.test(f))
    .sort();

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const filename of files) {
    const raw = readFileSync(join(BLOG_DIR, filename), "utf8");
    const parsed = parseFrontmatter(raw);

    if (!parsed) {
      console.log(`  SKIP: ${filename} (no frontmatter)`);
      skipped++;
      continue;
    }

    const slug = filenameToSlug(filename);
    const canonicalUrl = `${BASE_URL}/${slug}`;
    const title = parsed.meta.title || filename;

    // Build Dev.to tags (max 4, lowercase, no special chars)
    const tags = DEFAULT_TAGS;

    // Check if already exists
    const existingArticle = existingByCanonical.get(canonicalUrl);

    const articleData = {
      article: {
        title,
        body_markdown: parsed.content,
        published: true,
        canonical_url: canonicalUrl,
        tags,
        series: SERIES,
      },
    };

    try {
      if (existingArticle) {
        // Update existing
        await devtoRequest("PUT", `/articles/${existingArticle.id}`, articleData);
        console.log(`  UPDATE: ${filename} → dev.to (id: ${existingArticle.id})`);
        updated++;
      } else {
        // Create new
        const result = await devtoRequest("POST", "/articles", articleData);
        console.log(`  CREATE: ${filename} → dev.to (id: ${result.id}, url: ${result.url})`);
        created++;
      }
    } catch (err) {
      console.error(`  ERROR: ${filename} — ${err.message}`);
    }

    // Rate limit: Dev.to allows 10 requests per 30 seconds
    await new Promise((r) => setTimeout(r, 3500));
  }

  console.log(`\nDone. Created: ${created}, Updated: ${updated}, Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error("Cross-post failed:", err.message);
  process.exit(1);
});
