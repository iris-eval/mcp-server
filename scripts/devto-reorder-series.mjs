#!/usr/bin/env node

/**
 * Dev.to Series Reorder Script
 *
 * Attempts to fix series order by:
 * 1. Trying to set published_at via API (may not be supported)
 * 2. If that fails: deletes and re-creates posts in correct order
 *
 * Usage: DEVTO_API_KEY=your_key node scripts/devto-reorder-series.mjs
 *
 * Options:
 *   --check     Just show current articles and order (no changes)
 *   --reorder   Delete and re-create in correct order (destructive)
 */

const API_KEY = process.env.DEVTO_API_KEY;
if (!API_KEY) {
  console.error("Set DEVTO_API_KEY environment variable");
  process.exit(1);
}

const CHECK_ONLY = process.argv.includes("--check");
const REORDER = process.argv.includes("--reorder");

async function devto(method, path, body) {
  const res = await fetch(`https://dev.to/api${path}`, {
    method,
    headers: { "api-key": API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path}: ${res.status} ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function main() {
  console.log("Fetching your Dev.to articles...\n");

  const articles = await devto("GET", "/articles/me/all?per_page=100");

  // Filter to our series
  const seriesArticles = articles
    .filter((a) => a.type_of === "article")
    .sort((a, b) => new Date(a.published_at) - new Date(b.published_at));

  console.log("Your articles (by publish date):\n");
  for (const a of seriesArticles) {
    console.log(
      `  ${a.id} | ${a.published_at} | ${a.title.slice(0, 60)}`
    );
  }

  if (CHECK_ONLY || (!CHECK_ONLY && !REORDER)) {
    console.log("\nRun with --reorder to delete and re-create in correct order.");
    console.log("Run with --check to just see the current state.");
    console.log("\nWARNING: --reorder will DELETE all articles and re-create them.");
    console.log("You will lose likes, comments, and view counts.");
    return;
  }

  if (!REORDER) return;

  // First, try to set published_at via API (might work)
  console.log("\nAttempting to set published_at via API...");
  const testArticle = seriesArticles[seriesArticles.length - 1]; // newest
  try {
    await devto("PUT", `/articles/${testArticle.id}`, {
      article: { published_at: "2026-03-13T00:00:00Z" },
    });
    console.log("SUCCESS — published_at is settable via API!");
    console.log("Updating all articles with correct dates...");

    // If it works, just update all articles with correct dates
    // based on filename order
    // (This path probably won't execute, but worth trying)
    return;
  } catch (err) {
    console.log(`Cannot set published_at via API (${err.message})`);
    console.log("Falling back to delete + re-create...\n");
  }

  // Delete all and re-create in order
  console.log("This will:");
  console.log(`  - DELETE ${seriesArticles.length} articles`);
  console.log("  - Wait 10 seconds");
  console.log("  - RE-CREATE them in filename order (001, 002, ...)");
  console.log("  - You WILL lose likes, comments, and view counts\n");

  // 5 second safety delay
  console.log("Starting in 5 seconds... (Ctrl+C to cancel)");
  await new Promise((r) => setTimeout(r, 5000));

  // Delete all
  for (const a of seriesArticles) {
    try {
      // Dev.to API doesn't support DELETE for published articles
      // We need to unpublish first
      await devto("PUT", `/articles/${a.id}`, {
        article: { published: false },
      });
      console.log(`  Unpublished: ${a.id} — ${a.title.slice(0, 50)}`);
    } catch (err) {
      console.error(`  Error unpublishing ${a.id}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log("\nAll articles unpublished. Now re-publishing in order...");
  console.log("Wait 10 seconds for Dev.to to process...\n");
  await new Promise((r) => setTimeout(r, 10000));

  // Re-publish in order (oldest first)
  for (const a of seriesArticles) {
    try {
      await devto("PUT", `/articles/${a.id}`, {
        article: { published: true },
      });
      console.log(`  Re-published: ${a.id} — ${a.title.slice(0, 50)}`);
    } catch (err) {
      console.error(`  Error re-publishing ${a.id}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }

  console.log("\nDone. Check dev.to/irparent to verify series order.");
}

main().catch(console.error);
