#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Product Claims Consistency Check
#
# Validates that hardcoded product stats on the website match
# the actual source code. Fails CI if claims drift.
#
# Add new checks here as the product grows.
# ============================================================

ERRORS=0

# Count actual MCP tools registered in source
TOOL_COUNT=$(grep -c 'server\.tool(' src/tools/*.ts 2>/dev/null || echo "0")
echo "Actual MCP tools in source: $TOOL_COUNT"

# Count actual eval rules in source
RULE_COUNT=$(grep -c "rule:" src/eval/rules/*.ts 2>/dev/null || echo "0")
echo "Actual eval rules in source: $RULE_COUNT"

# Check website claims (search for hardcoded "3 MCP tools" or "12" in stats)
# This is intentionally broad — we want to catch any hardcoded claim
WEBSITE_TOOL_CLAIMS=$(grep -r "3 MCP tools\|3 tools" website/src/ 2>/dev/null | wc -l)
WEBSITE_RULE_CLAIMS=$(grep -r "12 built-in\|12 eval" website/src/ 2>/dev/null | wc -l)

if [ "$TOOL_COUNT" -gt 0 ] && [ "$WEBSITE_TOOL_CLAIMS" -gt 0 ]; then
  echo "  Website claims '3 MCP tools' in $WEBSITE_TOOL_CLAIMS place(s), source has $TOOL_COUNT"
  if [ "$TOOL_COUNT" != "3" ]; then
    echo "  WARNING: Tool count changed but website still says '3 MCP tools'"
    ERRORS=$((ERRORS + 1))
  fi
fi

if [ "$RULE_COUNT" -gt 0 ] && [ "$WEBSITE_RULE_CLAIMS" -gt 0 ]; then
  echo "  Website claims '12 eval rules' in $WEBSITE_RULE_CLAIMS place(s), source has $RULE_COUNT"
  if [ "$RULE_COUNT" != "12" ]; then
    echo "  WARNING: Rule count changed but website still says '12 eval rules'"
    ERRORS=$((ERRORS + 1))
  fi
fi

echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo "Product claims check FAILED — website stats are stale."
  echo "Update website components to match actual product capabilities."
  exit 1
fi

echo "Product claims check PASSED."
