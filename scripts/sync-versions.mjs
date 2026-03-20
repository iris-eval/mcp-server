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

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const VERSION = pkg.version;

// ============================================================
// Files that carry version numbers.
// Add new entries here as the project grows.
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
  // Add more here:
  // { path: "some/other/file.json", description: "What this file is for" },
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
  }

  writeFileSync(file.path, JSON.stringify(content, null, 2) + "\n");
  console.log(`  SYNC: ${file.path} (${current} → ${VERSION})`);
  updated++;
}

console.log(`\nDone. ${updated} file(s) updated, ${skipped} skipped.`);
if (updated > 0) {
  console.log("Don't forget to commit the changes.");
}
