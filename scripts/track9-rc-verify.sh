#!/usr/bin/env bash
# Track 9 — verify v0.4.0-rc.1 release artifacts after the workflow runs.
# Run AFTER the release workflow completes successfully.
set -euo pipefail

VERSION="v0.4.0-rc.1"
NPM_VERSION="0.4.0-rc.1"
PASSES=0
FAILS=0

pass() { echo "  ✓ $1"; PASSES=$((PASSES+1)); }
fail() { echo "  ✗ $1"; FAILS=$((FAILS+1)); }

echo "=== 1. npm: published under 'next' tag, NOT latest ==="
NPM_LATEST=$(npm view @iris-eval/mcp-server@latest version 2>/dev/null)
NPM_NEXT=$(npm view @iris-eval/mcp-server@next version 2>/dev/null)
echo "  latest=${NPM_LATEST}  next=${NPM_NEXT}"
[ "$NPM_NEXT" = "$NPM_VERSION" ] && pass "next dist-tag → ${NPM_VERSION}" || fail "expected next=${NPM_VERSION}, got ${NPM_NEXT}"
[ "$NPM_LATEST" != "$NPM_VERSION" ] && pass "latest dist-tag is NOT the RC (${NPM_LATEST})" || fail "RC accidentally became latest"

echo ""
echo "=== 2. npm: provenance attestation ==="
NPM_PROVENANCE=$(npm view @iris-eval/mcp-server@${NPM_VERSION} 2>/dev/null | grep -i 'attestations\|provenance' | head -3 || echo "")
[ -n "$NPM_PROVENANCE" ] && pass "provenance present in npm metadata" || fail "no provenance metadata returned by npm view"

echo ""
echo "=== 3. GitHub release: prerelease=true, isLatest=false ==="
GH_REL=$(gh release view "${VERSION}" --json isPrerelease,isLatest,tagName,assets --repo iris-eval/mcp-server 2>/dev/null)
echo "$GH_REL" | head -5
PRERELEASE=$(echo "$GH_REL" | python -c 'import json,sys; print(json.load(sys.stdin).get("isPrerelease"))')
ISLATEST=$(echo "$GH_REL" | python -c 'import json,sys; print(json.load(sys.stdin).get("isLatest"))')
[ "$PRERELEASE" = "True" ] && pass "isPrerelease=true" || fail "isPrerelease=${PRERELEASE} (expected True)"
[ "$ISLATEST" = "False" ] && pass "isLatest=false (RC didn't displace stable)" || fail "isLatest=${ISLATEST} (expected False)"
ASSET_COUNT=$(echo "$GH_REL" | python -c 'import json,sys; print(len(json.load(sys.stdin).get("assets",[])))')
[ "$ASSET_COUNT" -gt 0 ] && pass "${ASSET_COUNT} asset(s) attached (incl SBOMs)" || fail "no assets attached"

echo ""
echo "=== 4. Docker: published, but :latest not bumped ==="
docker pull "ghcr.io/iris-eval/mcp-server:${VERSION}" 2>&1 | tail -2
DOCKER_RC=$(docker images "ghcr.io/iris-eval/mcp-server:${VERSION}" --format '{{.ID}}')
DOCKER_LATEST=$(docker images "ghcr.io/iris-eval/mcp-server:latest" --format '{{.ID}}' 2>/dev/null || echo "none")
echo "  rc image=${DOCKER_RC} | latest image=${DOCKER_LATEST}"
[ -n "$DOCKER_RC" ] && pass "RC Docker tag pulled" || fail "RC Docker tag missing"
[ "$DOCKER_RC" != "$DOCKER_LATEST" ] && pass "RC did not overwrite :latest" || fail "RC accidentally became :latest"

echo ""
echo "=== 5. Cosign keyless verify on Docker image ==="
if command -v cosign >/dev/null 2>&1; then
  cosign verify "ghcr.io/iris-eval/mcp-server:${VERSION}" \
    --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
    --certificate-identity-regexp='^https://github.com/iris-eval/mcp-server/' \
    >/dev/null 2>&1 \
    && pass "cosign verify ok" \
    || fail "cosign verify failed (or cosign not available)"
else
  echo "  (cosign not installed — skipping)"
fi

echo ""
echo "=== 6. GitHub attestation verify ==="
if command -v gh >/dev/null 2>&1; then
  gh attestation verify \
    "oci://ghcr.io/iris-eval/mcp-server:${VERSION}" \
    --owner iris-eval --repo iris-eval/mcp-server \
    >/dev/null 2>&1 \
    && pass "gh attestation verify ok" \
    || fail "gh attestation verify failed"
fi

echo ""
echo "=== 7. Clean-dir install + smoke ==="
TMPDIR_INSTALL=$(mktemp -d)
cd "$TMPDIR_INSTALL"
npm init -y >/dev/null
npm install "@iris-eval/mcp-server@${NPM_VERSION}" --no-audit --no-fund 2>&1 | tail -2
node ./node_modules/@iris-eval/mcp-server/dist/index.js --help 2>&1 | grep -q "Iris" \
  && pass "RC --help works in clean install" \
  || fail "RC --help failed"
node -e 'const v = require("@iris-eval/mcp-server/package.json").version; if (v !== "'"$NPM_VERSION"'") { console.error("version mismatch", v); process.exit(1) }' \
  && pass "Installed package.json version = ${NPM_VERSION}" \
  || fail "Installed version mismatch"
cd / && rm -rf "$TMPDIR_INSTALL"

echo ""
echo "=== Track 9 results ==="
echo "${PASSES} passed, ${FAILS} failed"
[ "$FAILS" -eq 0 ]
