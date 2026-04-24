#!/usr/bin/env bash
# Post-v0.4.0 launch monitoring snapshot.
#
# Captures npm downloads, GitHub stars/forks, MCP Registry state, and
# cascade status. Run hourly (or on-demand) to build a trend curve for
# AI Council v1 review (4/26) and the YC submit-day metrics snapshot.
#
# Output: strategy/proof/launch-snapshots/YYYY-MM-DDTHH-MM-SSZ.json
#
# Usage: bash scripts/post-launch-snapshot.sh
set -uo pipefail

OUT_DIR=${OUT_DIR:-/c/dev/project_new_idea/strategy/proof/launch-snapshots}
mkdir -p "$OUT_DIR"
NOW=$(date -u +%Y-%m-%dT%H-%M-%SZ)
OUT="$OUT_DIR/$NOW.json"

# npm — last 30d downloads (single API, no auth)
NPM_30D=$(curl -s "https://api.npmjs.org/downloads/point/last-month/@iris-eval/mcp-server" | python -c "import json,sys; print(json.load(sys.stdin).get('downloads',0))" 2>/dev/null || echo 0)
NPM_LAST_DAY=$(curl -s "https://api.npmjs.org/downloads/point/last-day/@iris-eval/mcp-server" | python -c "import json,sys; print(json.load(sys.stdin).get('downloads',0))" 2>/dev/null || echo 0)
NPM_LATEST_VERSION=$(npm view @iris-eval/mcp-server@latest version 2>/dev/null || echo "?")

# GitHub — stars, forks, watchers, open issues (gh CLI)
GH=$(gh repo view iris-eval/mcp-server --json stargazerCount,forkCount,watchers,openGraphImageUrl 2>/dev/null || echo "{}")
STARS=$(echo "$GH" | python -c "import json,sys; print(json.load(sys.stdin).get('stargazerCount',0))" 2>/dev/null || echo 0)
FORKS=$(echo "$GH" | python -c "import json,sys; print(json.load(sys.stdin).get('forkCount',0))" 2>/dev/null || echo 0)
WATCHERS=$(echo "$GH" | python -c "import json,sys; print(json.load(sys.stdin).get('watchers',{}).get('totalCount',0))" 2>/dev/null || echo 0)

# Dependabot + CodeQL alert counts (open only)
DEPENDABOT_OPEN=$(gh api repos/iris-eval/mcp-server/dependabot/alerts?state=open -q 'length' 2>/dev/null || echo 0)
CODEQL_OPEN=$(gh api repos/iris-eval/mcp-server/code-scanning/alerts?state=open -q 'length' 2>/dev/null || echo 0)

# MCP Registry — isLatest version
MCP_LATEST=$(curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=iris-eval" 2>/dev/null | python -c "
import json,sys
try:
    d = json.load(sys.stdin)
    for s in d.get('servers', []):
        m = s.get('_meta', {}).get('io.modelcontextprotocol.registry/official', {})
        if m.get('isLatest'):
            print(s['server']['version'])
            break
    else:
        print('?')
except:
    print('?')
" 2>/dev/null)

# Cascade check — return HTTP codes for each
PULSEMCP=$(curl -s -o /dev/null -w "%{http_code}" "https://www.pulsemcp.com/servers/iris-eval-mcp-server" --max-time 8 2>/dev/null || echo "000")
MCP_SO=$(curl -s -o /dev/null -w "%{http_code}" "https://mcp.so/server/iris-eval" --max-time 8 2>/dev/null || echo "000")
MCPSERVERS_ORG=$(curl -s -o /dev/null -w "%{http_code}" "https://mcpservers.org/?q=iris-eval" --max-time 8 2>/dev/null || echo "000")

# Docker — :latest digest (short hash only)
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:iris-eval/mcp-server:pull" | python -c "import json,sys; print(json.load(sys.stdin)['token'])" 2>/dev/null || echo "")
DOCKER_LATEST=$(curl -sI -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.index.v1+json" "https://ghcr.io/v2/iris-eval/mcp-server/manifests/latest" 2>/dev/null | grep -i docker-content-digest | tr -d '\r\n' | awk '{print $2}' | cut -c1-19 || echo "?")

# Write snapshot
cat > "$OUT" <<EOF
{
  "capturedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "npm": {
    "latestVersion": "$NPM_LATEST_VERSION",
    "downloads30d": $NPM_30D,
    "downloads1d": $NPM_LAST_DAY
  },
  "github": {
    "stars": $STARS,
    "forks": $FORKS,
    "watchers": $WATCHERS,
    "dependabotOpen": $DEPENDABOT_OPEN,
    "codeqlOpen": $CODEQL_OPEN
  },
  "mcpRegistry": {
    "isLatestVersion": "$MCP_LATEST"
  },
  "docker": {
    "latestDigestShort": "$DOCKER_LATEST"
  },
  "cascade": {
    "pulseMcpHttp": "$PULSEMCP",
    "mcpSoHttp": "$MCP_SO",
    "mcpServersOrgHttp": "$MCPSERVERS_ORG"
  }
}
EOF

echo "Snapshot written: $OUT"
cat "$OUT"
