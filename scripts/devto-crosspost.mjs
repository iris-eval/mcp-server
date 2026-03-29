#!/usr/bin/env node

/**
 * Dev.to Cross-Post Automation
 *
 * Reads all blog posts from docs/blog/, formats them for Dev.to,
 * and creates or updates them via the Dev.to API.
 *
 * Environment variables:
 *   DEVTO_API_KEY  — Required. Get from https://dev.to/settings/extensions
 *   MAX_NEW        — Max new posts to create per run (default 2, prevents spam)
 *   DRY_RUN        — "true" to preview without posting
 *
 * Behavior:
 *   - UPDATES existing posts (matched by canonical_url) — always, no limit
 *   - CREATES new posts — limited to MAX_NEW per run to avoid spam flags
 *   - All posts get canonical_url → iris-eval.com, series → "MCP Agent Observability"
 *   - Posts are processed in filename order (001, 002, ...) so series order is correct
 *
 * To cross-post a new blog:
 *   1. Create docs/blog/0XX-my-post.md with YAML frontmatter
 *   2. Push to main
 *   3. Action runs, creates up to MAX_NEW new posts
 *   4. Run manually with higher MAX_NEW to publish more in one batch
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const API_KEY = process.env.DEVTO_API_KEY;
const MAX_NEW = parseInt(process.env.MAX_NEW || "2", 10);
const DRY_RUN = process.env.DRY_RUN === "true";

if (!API_KEY) {
  console.error("DEVTO_API_KEY not set. Skipping cross-post.");
  process.exit(0);
}

const BLOG_DIR = join(process.cwd(), "docs", "blog");
const SERIES = "MCP Agent Observability";
const BASE_URL = "https://iris-eval.com/blog";
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
      val = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim());
    }
    meta[key] = val;
  }

  // Remove H1 if it duplicates the title
  let content = match[2].trim();
  const firstLine = content.split("\n")[0];
  if (firstLine.startsWith("# ")) {
    content = content.slice(firstLine.length).trim();
  }

  // Convert relative URLs to absolute for Dev.to
  content = content.replace(/\]\(\//g, "](https://iris-eval.com/");

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
  const articles = await devtoRequest("GET", "/articles/me/all?per_page=100");
  return articles;
}

async function main() {
  console.log(`Cross-posting to Dev.to (max_new: ${MAX_NEW}, dry_run: ${DRY_RUN})\n`);

  // Get all existing Dev.to articles
  const existing = await getExistingArticles();
  const existingByCanonical = new Map();
  for (const article of existing) {
    if (article.canonical_url) {
      existingByCanonical.set(article.canonical_url, article);
    }
  }
  console.log(`Found ${existing.length} existing Dev.to article(s)\n`);

  // Read all blog posts (sorted by filename for correct series order)
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

    const articleData = {
      article: {
        title,
        body_markdown: parsed.content,
        published: true,
        canonical_url: canonicalUrl,
        tags: DEFAULT_TAGS,
        series: SERIES,
      },
    };

    // Check if already exists on Dev.to
    const existingArticle = existingByCanonical.get(canonicalUrl);

    try {
      if (existingArticle) {
        // Always update existing posts
        if (DRY_RUN) {
          console.log(`  DRY: Would UPDATE ${filename} (id: ${existingArticle.id})`);
        } else {
          await devtoRequest("PUT", `/articles/${existingArticle.id}`, articleData);
          console.log(`  UPDATE: ${filename} (id: ${existingArticle.id})`);
        }
        updated++;
      } else if (created < MAX_NEW) {
        // Create new — but only up to MAX_NEW
        if (DRY_RUN) {
          console.log(`  DRY: Would CREATE ${filename} → ${canonicalUrl}`);
        } else {
          const result = await devtoRequest("POST", "/articles", articleData);
          console.log(`  CREATE: ${filename} → ${result.url}`);
        }
        created++;
      } else {
        console.log(`  DEFER: ${filename} (max_new limit reached, will create next run)`);
        skipped++;
      }
    } catch (err) {
      console.error(`  ERROR: ${filename} — ${err.message}`);
    }

    // Rate limit: Dev.to allows 10 requests per 30 seconds
    if (!DRY_RUN) {
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  console.log(
    `\nDone. Created: ${created}, Updated: ${updated}, Skipped/Deferred: ${skipped}`
  );

  if (skipped > 0 && created >= MAX_NEW) {
    console.log(
      `\nSome posts were deferred. Run again or increase MAX_NEW to publish more.`
    );
    console.log(
      `Manual trigger: Actions → Cross-post to Dev.to → Run workflow → set max_new`
    );
  }
}

main().catch((err) => {
  console.error("Cross-post failed:", err.message);
  process.exit(1);
});
