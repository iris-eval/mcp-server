#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Version Consistency Check
# Single source of truth: package.json
# Add new version-carrying files to the CHECKS array below.
# ============================================================

PKG_VERSION=$(node -p "require('./package.json').version")
ERRORS=0

check_version() {
  local file="$1"
  local jq_path="$2"
  local actual

  if [ ! -f "$file" ]; then
    # A missing file is a FAILURE, not a skip. Silently passing over one
    # means renaming or moving a version-carrying file turns this gate into
    # a no-op that still reports "PASSED: all files at X" — the same
    # not-actually-covered failure that let plugin.json sit at 0.4.4 for a
    # whole release. If a file is genuinely gone, delete its check here.
    echo "MISSING: $file (expected a version-carrying file)"
    ERRORS=$((ERRORS + 1))
    return
  fi

  actual=$(node -p "require('./$file')$jq_path")

  if [ "$actual" != "$PKG_VERSION" ]; then
    echo "MISMATCH: $file ($actual) != package.json ($PKG_VERSION)"
    ERRORS=$((ERRORS + 1))
  else
    echo "  OK: $file ($actual)"
  fi
}

echo "Checking all versions against package.json ($PKG_VERSION)..."
echo ""

# Core manifests
check_version "server.json" ".version"
# server.json ALSO carries the npm version inside packages[] — the reference
# clients follow to install. It drifted to 0.4.4 while the top-level version
# said 0.4.5, and this gate passed because it only looked at `.version`.
# Publishing that to the MCP Registry would have advertised 0.4.5 while
# pointing installs at the previous (vulnerable) package.
#
# Every entry, not just [0]: sync-versions.mjs loops over the whole array,
# so pinning the check to one index leaves the checker and the syncer
# disagreeing about what "all version sites" means. Adding a second package
# would silently escape the gate.
check_all_packages() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "MISSING: $file (expected a version-carrying file)"
    ERRORS=$((ERRORS + 1))
    return
  fi
  local count
  count=$(node -p "(require('./$file').packages || []).length")
  if [ "$count" = "0" ]; then
    echo "MISSING: $file has no packages[] entries to check"
    ERRORS=$((ERRORS + 1))
    return
  fi
  local i=0
  while [ "$i" -lt "$count" ]; do
    check_version "$file" ".packages[$i].version"
    i=$((i + 1))
  done
}
check_all_packages "server.json"
check_version "package-lock.json" ".version"

# Agent discovery endpoint
check_version "website/public/.well-known/mcp.json" ".version"

# Claude Code plugin manifest — the version plugin users see. scripts/
# sync-versions.mjs has always WRITTEN this file, but nothing checked it,
# so the syncer moved on and the gate never noticed: it sat at 0.4.4
# through the entire 0.4.5 release. Checker and syncer must cover the same
# set of files or the gate is decorative.
check_version ".claude-plugin/plugin.json" ".version"

# The OTHER plugin manifest — and the one that matters. The marketplace
# index (.claude-plugin/marketplace.json) points plugin installs at
# `./claude-plugin`, so claude-plugin/.claude-plugin/plugin.json is the
# version a `/plugin install iris-eval` user actually gets. The gate above
# covered the root manifest no marketplace entry points at, reported
# PASSED, and this file sat at 0.1.0 while the product shipped 0.5.0 and
# 0.5.1. Same lesson as the lockfile and server.json packages[]: the gate
# must walk the surface the USER sees, not the one that is easy to find.
check_version "claude-plugin/.claude-plugin/plugin.json" ".version"

# @iris-eval/langchain's dependency range on this package. Not a `.version`
# field and not synced (the adapter releases on its own cadence), but the
# range must admit the version being released: `^0.4.0` excluded every
# 0.5.x, so a fresh install of the adapter resolved to the pre-veto,
# pre-sandbox 0.4.6 line for the whole 0.5.0 release. Fails when the range
# does not admit the current version; the fix is a deliberate hand edit.
if node scripts/check-langchain-range.mjs; then
  :
else
  ERRORS=$((ERRORS + 1))
fi

# SECURITY.md's supported-versions table. Not a `.version` field, so it needs
# its own check — and it earned one: the policy says "only the latest minor
# receives security fixes", and on v0.5.0's ship day the table still listed
# 0.4.x as supported and told readers to upgrade to it. By the policy's own
# rule the security page was advertising an UNSUPPORTED line as the supported
# one. A version-carrying surface no gate walks drifts on exactly the release
# where it matters most.
if node scripts/check-security-minor.mjs; then
  :
else
  ERRORS=$((ERRORS + 1))
fi

# ============================================================
# Add new version-carrying files here as the project grows:
# check_version "path/to/file.json" ".version"
# ============================================================

echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo "Version check FAILED with $ERRORS mismatch(es)."
  echo "Run 'node scripts/sync-versions.mjs' to fix automatically."
  exit 1
fi

echo "Version check PASSED: all files at $PKG_VERSION"
