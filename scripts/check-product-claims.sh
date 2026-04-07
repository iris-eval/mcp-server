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

# ------------------------------------------------------------
# Ground truth counts from source code
# ------------------------------------------------------------

# MCP tool count: each tool is registered via a register*Tool function
# imported in src/tools/index.ts. Counting registerXTool calls there.
TOOL_COUNT=$(grep -c "register.*Tool(" src/tools/index.ts || true)
echo "Actual MCP tools registered: $TOOL_COUNT"

# Eval rule count: each rule is an exported `const x: EvalRule = {...}`.
# This counts top-level rule definitions across the four categories,
# excluding rule arrays (`EvalRule[]`) and the custom rule wrapper.
RULE_COUNT=$(grep -h "export const.*: EvalRule = {" src/eval/rules/completeness.ts src/eval/rules/relevance.ts src/eval/rules/safety.ts src/eval/rules/cost.ts | wc -l)
echo "Actual eval rules in source: $RULE_COUNT"

# ------------------------------------------------------------
# Website claim validation
# Each check: if the website has a hardcoded number, it must match
# the source-of-truth count.
# ------------------------------------------------------------

check_website_claim() {
  local label="$1"        # e.g. "MCP tools"
  local pattern="$2"      # e.g. "([0-9]+) MCP tools"
  local expected="$3"     # source-of-truth count

  # Find every line that matches the pattern in website source
  local matches
  matches=$(grep -rhE "$pattern" website/src/ 2>/dev/null || true)

  if [ -z "$matches" ]; then
    echo "  No website claims found for: $label"
    return 0
  fi

  # Extract the numbers from matches and check each
  local found_numbers
  found_numbers=$(echo "$matches" | grep -oE "$pattern" | grep -oE '^[0-9]+' | sort -u)

  for n in $found_numbers; do
    if [ "$n" != "$expected" ]; then
      echo "  MISMATCH: website says \"$n $label\" but source has $expected"
      ERRORS=$((ERRORS + 1))
    else
      echo "  OK: website says \"$n $label\" (matches source)"
    fi
  done
}

check_website_claim "MCP tools" '[0-9]+ MCP tools' "$TOOL_COUNT"
check_website_claim "built-in rules" '[0-9]+ built-in (rules|eval rules)' "$RULE_COUNT"
check_website_claim "eval rules" '[0-9]+ eval rules' "$RULE_COUNT"

echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo "Product claims check FAILED — website stats are stale."
  echo "Update website components to match actual product capabilities."
  exit 1
fi

echo "Product claims check PASSED."
