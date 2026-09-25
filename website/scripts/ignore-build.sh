#!/bin/sh
# Vercel's Ignored Build Step for the site: exit 0 skips the build, exit 1 builds.
# The site reads website/, docs/blog/ and .claims.json; a change confined to
# dashboard/, tests/, packages/ or .github/ never changes it. The comparison is
# against the last successful deployment for the branch, so a refused or failed
# site deployment is never followed by a skipped one. If that commit is gone (a
# force-pushed branch) the parent is used, and any git error builds: the host
# fails the deployment on an exit code above 1 instead of building.
base="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
git cat-file -e "${base}^{commit}" 2>/dev/null || base="HEAD^"
if git diff --quiet "$base" HEAD -- ':(top)' ':(top,exclude)dashboard' ':(top,exclude)tests' ':(top,exclude)packages' ':(top,exclude).github'; then
  exit 0
fi
exit 1
