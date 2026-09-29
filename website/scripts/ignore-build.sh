#!/bin/sh
# Vercel's Ignored Build Step for the site: exit 0 skips the build, exit 1 builds.
#
# The site's build reads three things in this repository: website/, the blog
# posts in docs/blog/ (src/lib/blog.ts), and .claims.json (src/lib/claims.ts);
# tests/website-build-scope.test.ts fails if a website source reaches anything
# else. A deployment builds only when one of those changed:
#   - production (main): website/, docs/blog/, or .claims.json with anything
#     but its generatedAt / generatedFromCommit stamp different, so the live
#     numbers follow every merge that moves them;
#   - preview (a branch or pull request): website/ or docs/blog/. A change
#     that only moves .claims.json values does not change how the site is
#     built; CI's website job builds and typechecks the site against the
#     branch's .claims.json on every pull request, and production rebuilds
#     on merge.
# The comparison is against the last successful deployment for the branch,
# so a refused or failed deployment is never followed by a skipped one. If
# that commit is gone (a force-pushed branch) the parent is used. Any git or
# node error builds: the host fails the deployment on an exit code above 1
# instead of building.
base="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
git cat-file -e "${base}^{commit}" 2>/dev/null || base="HEAD^"
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
