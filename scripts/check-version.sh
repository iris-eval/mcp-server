#!/usr/bin/env bash
set -euo pipefail

# Single source of truth: package.json
PKG_VERSION=$(node -p "require('./package.json').version")
SERVER_VERSION=$(node -p "require('./server.json').version")
LOCK_VERSION=$(node -p "require('./package-lock.json').version")

ERRORS=0

if [ "$SERVER_VERSION" != "$PKG_VERSION" ]; then
  echo "MISMATCH: server.json version ($SERVER_VERSION) != package.json ($PKG_VERSION)"
  ERRORS=$((ERRORS + 1))
fi

if [ "$LOCK_VERSION" != "$PKG_VERSION" ]; then
  echo "MISMATCH: package-lock.json version ($LOCK_VERSION) != package.json ($PKG_VERSION)"
  ERRORS=$((ERRORS + 1))
fi

if [ "$ERRORS" -gt 0 ]; then
  echo "Version check failed with $ERRORS mismatch(es)."
  exit 1
fi

echo "Version check passed: $PKG_VERSION"
