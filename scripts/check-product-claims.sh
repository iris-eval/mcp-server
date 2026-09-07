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

  # Find every line that matches the pattern in website source.
  #
  # A milestone row marked `status: "Released"` is a HISTORICAL RECORD of what
  # that version shipped, not a claim about today: the roadmap's v0.4 row says
  # "9 MCP tools" because v0.4 shipped nine, and rewriting it to today's count
  # would make it false. Rows marked "In progress" or "Planned" ARE forward
  # claims about the current product and stay checked, as does every other
  # line in website/src.
  #
  # Found when the tool count first moved since v0.4 (9 -> 11): this gate read
  # a dated line as a live one. The bigger scanner already classifies dated
  # artifacts; this one had no such notion.
  local matches
  matches=$(grep -rhE "$pattern" website/src/ 2>/dev/null | grep -v 'status: "Released"' || true)

  if [ -z "$matches" ]; then
    # Zero hardcoded claims is the GOAL state, not a coverage hole — the
    # website renders these counts from constants in website/src/lib/claims.
    # But "found nothing, therefore green" is how a gate ends up verifying
    # nothing at all, so when there is no literal to compare, this asserts the
    # derived constant is actually imported somewhere. Deleting the constant
    # and typing a number back in is then caught by the branch above; deleting
    # it and typing nothing is caught here.
    if [ -n "$4" ] && ! grep -rq "$4" website/src/ 2>/dev/null; then
      echo "  MISSING: no hardcoded \"$label\" claim AND no use of $4 — the website states this count nowhere"
      ERRORS=$((ERRORS + 1))
    else
      echo "  OK: no hardcoded \"$label\" claim; the website derives it from $4"
    fi
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

check_website_claim "MCP tools" '[0-9]+ MCP tools' "$TOOL_COUNT" "MCP_TOOL_COUNT"
check_website_claim "built-in rules" '[0-9]+ built-in (rules|eval rules)' "$RULE_COUNT" "RULE_COUNT_BUILT_IN"
check_website_claim "eval rules" '[0-9]+ eval rules' "$RULE_COUNT" "RULE_COUNT_BUILT_IN"

echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo "Product claims check FAILED — website stats are stale."
  echo "Update website components to match actual product capabilities."
  exit 1
fi

echo "Product claims check PASSED."
