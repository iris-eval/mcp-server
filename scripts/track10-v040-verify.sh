#!/usr/bin/env bash
# Track 10 — verify v0.4.0 release artifacts.
# Run AFTER the release workflow completes. Asserts npm latest = v0.4.0,
# Docker :latest digest = v0.4.0 digest, GitHub release isPrerelease=false.
set -uo pipefail

VERSION="v0.4.0"
NPM_VERSION="0.4.0"
PASSES=0
FAILS=0

pass() { echo "  ✓ $1"; PASSES=$((PASSES+1)); }
fail() { echo "  ✗ $1"; FAILS=$((FAILS+1)); }

echo "=== 1. npm: published as latest ==="
NPM_LATEST=$(npm view @iris-eval/mcp-server@latest version 2>/dev/null)
echo "  latest=${NPM_LATEST}"
[ "$NPM_LATEST" = "$NPM_VERSION" ] && pass "latest dist-tag → ${NPM_VERSION}" || fail "expected latest=${NPM_VERSION}, got ${NPM_LATEST}"

echo ""
echo "=== 2. npm: provenance attestation ==="
PROV=$(npm view @iris-eval/mcp-server@${NPM_VERSION} dist.attestations 2>/dev/null | head -c 200)
echo "$PROV"
echo "$PROV" | grep -q 'slsa.dev/provenance' && pass "SLSA provenance present" || fail "no SLSA provenance"

echo ""
echo "=== 3. GHCR: latest tag points to v0.4.0 ==="
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:iris-eval/mcp-server:pull" | python -c 'import json,sys; print(json.load(sys.stdin)["token"])')
V040_DIGEST=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.index.v1+json" -I "https://ghcr.io/v2/iris-eval/mcp-server/manifests/v0.4.0" | grep -i docker-content-digest | cut -d' ' -f2 | tr -d '\r\n')
LATEST_DIGEST=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.index.v1+json" -I "https://ghcr.io/v2/iris-eval/mcp-server/manifests/latest" | grep -i docker-content-digest | cut -d' ' -f2 | tr -d '\r\n')
echo "  v0.4.0: $V040_DIGEST"
echo "  latest: $LATEST_DIGEST"
[ "$V040_DIGEST" = "$LATEST_DIGEST" ] && pass "Docker :latest = v0.4.0 (stable bumped)" || fail "Docker :latest does NOT match v0.4.0"
[ -n "$V040_DIGEST" ] && pass "v0.4.0 manifest exists" || fail "no v0.4.0 manifest"

echo ""
echo "=== 4. GitHub release: NOT prerelease ==="
GH=$(gh release view "${VERSION}" --json isPrerelease,isDraft,tagName --repo iris-eval/mcp-server 2>/dev/null)
echo "  $GH"
echo "$GH" | grep -q '"isPrerelease":false' && pass "isPrerelease=false (production release)" || fail "isPrerelease should be false"
echo "$GH" | grep -q '"isDraft":false' && pass "isDraft=false" || fail "isDraft should be false"

echo ""
echo "=== 5. Release assets ==="
ASSETS=$(gh release view "${VERSION}" --json assets --repo iris-eval/mcp-server -q '.assets[].name' 2>/dev/null)
echo "$ASSETS" | sed 's/^/  /'
echo "$ASSETS" | grep -q 'iris-npm-sbom.spdx.json' && pass "npm SBOM attached" || fail "npm SBOM missing"
echo "$ASSETS" | grep -q 'iris-docker-sbom.spdx.json' && pass "docker SBOM attached" || fail "docker SBOM missing"

echo ""
echo "=== 6. Clean-dir install + smoke ==="
TMPDIR_INSTALL=$(mktemp -d)
cd "$TMPDIR_INSTALL"
npm init -y >/dev/null 2>&1
npm install "@iris-eval/mcp-server" --no-audit --no-fund 2>&1 | tail -2
INSTALLED=$(node -e 'console.log(require("@iris-eval/mcp-server/package.json").version)')
[ "$INSTALLED" = "$NPM_VERSION" ] && pass "npm install (no @version) → ${NPM_VERSION} (latest tag works)" || fail "default install resolved to ${INSTALLED}"
node ./node_modules/@iris-eval/mcp-server/dist/index.js --help 2>&1 | grep -q "Iris" \
  && pass "iris-mcp --help works" \
  || fail "iris-mcp --help failed"
cd /
rm -rf "$TMPDIR_INSTALL"

echo ""
echo "=== Track 10 results ==="
echo "${PASSES} passed, ${FAILS} failed"
[ "$FAILS" -eq 0 ]
