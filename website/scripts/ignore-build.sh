#!/bin/sh
# Vercel's Ignored Build Step for the site: exit 0 skips the build, exit 1 builds.
#
# The site's build reads three things in this repository: website/, the blog
# posts in docs/blog/ (src/lib/blog.ts), and .claims.json (src/lib/claims.ts);
# tests/website-build-scope.test.ts fails if a website source reads anything
# else. A deployment builds only when one of those changed:
#   - production (main): website/, docs/blog/, or .claims.json with anything
#     but its generatedAt / generatedFromCommit stamp different, so the live
#     numbers follow every merge that moves them;
#   - preview (a branch or pull request): website/ or docs/blog/. A change
#     that only moves .claims.json values does not change how the site is
#     built; CI's website job runs the production build against the branch's
#     .claims.json on every pull request, and production rebuilds on merge.
#
# What it compares with:
#   - the last successful deployment of this branch (VERCEL_GIT_PREVIOUS_SHA),
#     so a skipped, refused or failed deployment is never the base;
#   - for a branch's first deployment (no previous one), the tip of main: a
#     change the branch makes to the site always differs from main, and a
#     site change main has that the branch lacks only costs a build.
# The host clones shallowly, so a base that is not in the clone is fetched
# (one commit, from the public repository). Anything that fails (the fetch,
# git, node) builds: the host fails the deployment on an exit code above 1
# instead of building, and a wrong skip would leave the site stale.
url="${SITE_REPO_URL:-https://github.com/${VERCEL_GIT_REPO_OWNER}/${VERCEL_GIT_REPO_SLUG}.git}"
base="$VERCEL_GIT_PREVIOUS_SHA"
if [ -z "$base" ]; then
  git fetch --quiet --depth=1 "$url" main 2>/dev/null || exit 1
  base="$(git rev-parse FETCH_HEAD)" || exit 1
fi
if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  git fetch --quiet --depth=1 "$url" "$base" 2>/dev/null || exit 1
  git cat-file -e "${base}^{commit}" 2>/dev/null || exit 1
fi
git diff --quiet "$base" HEAD -- ':(top)website' ':(top)docs/blog' || exit 1
if [ "$VERCEL_ENV" = "production" ]; then
  git diff --quiet "$base" HEAD -- ':(top).claims.json' && exit 0
  BASE="$base" node -e '
    const { execFileSync } = require("node:child_process");
    const read = (rev) => { const c = JSON.parse(execFileSync("git", ["show", rev + ":.claims.json"], { encoding: "utf8" })); delete c.generatedAt; delete c.generatedFromCommit; return JSON.stringify(c); };
    process.exit(read(process.env.BASE) === read("HEAD") ? 0 : 1);
  ' || exit 1
fi
exit 0
