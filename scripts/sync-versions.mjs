#!/usr/bin/env node

/**
 * Version Sync Script
 *
 * Reads the version from package.json (single source of truth)
 * and writes it to all other version-carrying files.
 *
 * Usage: node scripts/sync-versions.mjs
 *
 * To add a new file: add an entry to the FILES array below.
 * Each entry needs: path, a read function, and a write function.
 *
 * This script is idempotent — safe to run multiple times.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { createRequire } from "module";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const VERSION = pkg.version;

// ============================================================
// Files that carry version numbers.
// Add new entries here as the project grows — AND add the matching
// check_version line to scripts/check-version.sh. The checker and the
// syncer must cover the same set of files, or the release gate reports
// PASSED over a file the syncer never touched (this is how the served
// plugin manifest sat at 0.1.0 through four minor releases).
//
// NOTE: dashboard/package.json and packages/*/package.json are
// intentionally excluded. The dashboard pins 0.1.0 independently
// (separate Vite SPA release cadence, not part of MCP server releases).
// Companion packages (packages/langchain, etc.) version on their own
// cadence as ecosystem adapters. Before adding any of these, coordinate
// with the respective release process. Their DEPENDENCY RANGE on this
// package is a different matter — see the advisory after the loop.
// ============================================================
const FILES = [
  {
    path: "server.json",
    description: "MCP Registry manifest",
  },
  {
    path: "website/public/.well-known/mcp.json",
    description: "Agent auto-discovery endpoint",
  },
  {
    path: ".claude-plugin/plugin.json",
    description: "Claude Code plugin manifest (repo root)",
  },
  {
    // .claude-plugin/marketplace.json points plugin installs at
    // `./claude-plugin` — so THIS is the manifest a marketplace user sees,
    // not the root one above. It was never in this list: it shipped 0.1.0
    // while the product was at 0.5.1.
    path: "claude-plugin/.claude-plugin/plugin.json",
    description: "Claude Code plugin manifest the marketplace serves",
  },
  {
    path: "package-lock.json",
    description: "npm lockfile (root + packages[\"\"] version metadata only — never runs npm install; surgical write avoids the rolldown lockfile trap)",
  },
];

let updated = 0;
let skipped = 0;

console.log(`Syncing all versions to ${VERSION} (from package.json)\n`);

for (const file of FILES) {
  if (!existsSync(file.path)) {
    console.log(`  SKIP: ${file.path} (not found)`);
    skipped++;
    continue;
  }

  const content = JSON.parse(readFileSync(file.path, "utf8"));
  const current = content.version;

  if (current === VERSION) {
    console.log(`  OK:   ${file.path} (already ${VERSION})`);
    continue;
  }

  content.version = VERSION;

  // Also sync nested package versions (e.g., server.json packages[].version)
  if (Array.isArray(content.packages)) {
    for (const pkg of content.packages) {
      if (pkg.version && pkg.version !== VERSION) {
        console.log(`  SYNC: ${file.path} packages[].version (${pkg.version} → ${VERSION})`);
        pkg.version = VERSION;
      }
    }
  } else if (content.packages && typeof content.packages === "object" && content.packages[""]) {
    // package-lock.json shape: packages is an object with "" key for the root package
    const root = content.packages[""];
    if (root.version && root.version !== VERSION) {
      console.log(`  SYNC: ${file.path} packages[""].version (${root.version} → ${VERSION})`);
      root.version = VERSION;
    }
  }

  writeFileSync(file.path, JSON.stringify(content, null, 2) + "\n");
  console.log(`  SYNC: ${file.path} (${current} → ${VERSION})`);
  updated++;
}

// ------------------------------------------------------------
// Advisory, not a write: @iris-eval/langchain's dependency range on this
// package. A range is a policy choice (which server lines the adapter
// supports), so the syncer does not rewrite it — but it must still ADMIT
// the version being released. `^0.4.0` excluded every 0.5.x, so a fresh
// install of the adapter resolved to the pre-veto 0.4.6 line for a whole
// release. scripts/check-version.sh fails on this; here we say what to edit.
// ------------------------------------------------------------
const LANGCHAIN_PKG = "packages/langchain/package.json";
if (existsSync(LANGCHAIN_PKG)) {
  const lc = JSON.parse(readFileSync(LANGCHAIN_PKG, "utf8"));
  const range =
    lc.dependencies?.["@iris-eval/mcp-server"] ??
    lc.peerDependencies?.["@iris-eval/mcp-server"];
  if (range) {
    let semver;
    try {
      semver = createRequire(import.meta.url)("semver");
    } catch {
      console.log(`\n  NOTE: ${LANGCHAIN_PKG} range "${range}" not checked (semver not installed — run npm ci)`);
    }
    if (semver) {
      // Compare against the production version an RC precedes, so
      // 0.6.0-rc.1 asks "will the range accept 0.6.0?".
      const p = semver.parse(VERSION);
      const release = p ? `${p.major}.${p.minor}.${p.patch}` : VERSION;
      if (semver.satisfies(release, range)) {
        console.log(`\n  OK:   ${LANGCHAIN_PKG} depends on "@iris-eval/mcp-server": "${range}" (admits ${release})`);
      } else {
        console.log(`\n  REVIEW: ${LANGCHAIN_PKG} depends on "@iris-eval/mcp-server": "${range}" — that range does NOT admit ${release}.`);
        console.log(`          Edit it by hand (e.g. "^${p ? `${p.major}.${p.minor}.0` : release}"); npm run version:check will fail until it does.`);
      }
    }
  }
}

console.log(`\nDone. ${updated} file(s) updated, ${skipped} skipped.`);
if (updated > 0) {
  console.log("Don't forget to commit the changes.");
}
