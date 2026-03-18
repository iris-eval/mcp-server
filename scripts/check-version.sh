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
    echo "SKIP: $file not found"
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
check_version "package-lock.json" ".version"

# Agent discovery endpoint
check_version "website/public/.well-known/mcp.json" ".version"

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
