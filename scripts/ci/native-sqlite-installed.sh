#!/usr/bin/env bash
# Run after `npm ci` in a job that needs the native SQLite driver.
#
# better-sqlite3 is an optional dependency. When its prebuilt download fails
# and the source build fails too, npm drops it and still reports success, and
# every test that opens a store with the native driver then fails on its
# absence, which says nothing about the code under test. On 2026-10-24 the
# nightly worker-exit run's macOS Node 22 cell printed "added 310 packages",
# then failed all 50 of its search-worker runs on "The native SQLite module
# (better-sqlite3) is not installed".
#
# This loads the module and opens a database. If that fails, it installs once
# more with the install scripts' output in the log, so the cause is visible
# and one failed download does not fail the job; if the module still does not
# load, the job fails here, with that log above it.
set -euo pipefail

loads() { node -e "new (require('better-sqlite3'))(':memory:').close()"; }

if loads 2>/dev/null; then
  echo "better-sqlite3 $(node -p "require('better-sqlite3/package.json').version") loads on Node $(node -v)"
  exit 0
fi

echo "::warning::npm ci did not leave a working better-sqlite3 (it is optional, so npm drops it when its download and its source build both fail). Installing once more, with the install scripts' output shown."
npm ci --foreground-scripts

if ! loads; then
  echo "::error::better-sqlite3 still does not load on this runner; the install log above says why."
  exit 1
fi
echo "better-sqlite3 loads after the second install"
