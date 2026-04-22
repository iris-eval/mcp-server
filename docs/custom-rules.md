# Custom Eval Rules

Define your own evaluation criteria. Iris ships with 13 built-in rules across completeness, relevance, safety, and cost (as of v0.3.1). Custom rules let you enforce domain-specific requirements — regulatory compliance, output format constraints, brand guidelines, budget limits — evaluated with the same weighted scoring engine.

**How it works:** Pass a `custom_rules` array to `evaluate_output` with `eval_type: "custom"`. Each rule runs against the output, produces a score between 0 and 1, and the engine computes a weighted average. The evaluation passes when the score meets the configured threshold (default: `0.7`).

---

## Table of Contents

- [Quick Start](#quick-start)
- [Rule Types](#rule-types)
  - [regex_match](#regex_match)
  - [regex_no_match](#regex_no_match)
  - [min_length](#min_length)
  - [max_length](#max_length)
  - [contains_keywords](#contains_keywords)
  - [excludes_keywords](#excludes_keywords)
  - [json_schema](#json_schema)
  - [cost_threshold](#cost_threshold)
- [Scoring and Weights](#scoring-and-weights)
- [ReDoS Protection](#redos-protection)
- [Combining Built-in and Custom Rules](#combining-built-in-and-custom-rules)
- [Registering Rules Programmatically](#registering-rules-programmatically)
- [Reusable Rule Packages](#reusable-rule-packages)
- [Real-World Examples](#real-world-examples)
  - [HIPAA Compliance Check](#hipaa-compliance-check)
  - [Financial Accuracy Validation](#financial-accuracy-validation)
  - [Brand Voice Enforcement](#brand-voice-enforcement)

---

## Quick Start

The simplest custom rule: check that the output is valid JSON.

```json
{
  "output": "{\"status\": \"ok\", \"count\": 42}",
  "eval_type": "custom",
  "custom_rules": [
    {
      "name": "valid_json",
      "type": "json_schema",
      "config": {}
    }
  ]
}
```

Response:

```json
{
  "id": "eval_...",
  "score": 1,
  "passed": true,
  "rule_results": [
    {
      "ruleName": "valid_json",
      "passed": true,
      "score": 1,
      "message": "Output is valid JSON"
    }
  ],
  "suggestions": []
}
```

Add a second rule to require a minimum length. Now both rules contribute to the final score:

```json
{
  "output": "{\"status\": \"ok\", \"count\": 42}",
  "eval_type": "custom",
  "custom_rules": [
    {
      "name": "valid_json",
      "type": "json_schema",
      "config": {},
      "weight": 2
    },
    {
      "name": "not_trivial",
      "type": "min_length",
      "config": { "length": 10 }
    }
  ]
}
```

The `json_schema` rule has weight 2, `min_length` has weight 1 (default). Final score: `(1*2 + 1*1) / (2+1) = 1.0`.

---

## Rule Types

Every custom rule has the same structure:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | Yes | -- | Your identifier for this rule |
| `type` | `string` | Yes | -- | One of the 8 types below |
| `config` | `object` | Yes | -- | Type-specific configuration |
| `weight` | `number` | No | `1` | Weight in the final score calculation |

### regex_match

Output must match a regex pattern. Use for format validation, required structures, or content patterns.

**Config:**

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `pattern` | `string` | Yes | Regular expression pattern |
| `flags` | `string` | No | Regex flags (e.g., `"i"` for case-insensitive, `"g"` for global) |

**Scoring:** Binary. 1 if the pattern matches, 0 if it does not.

```json
{
  "name": "has_version_number",
  "type": "regex_match",
  "config": { "pattern": "v\\d+\\.\\d+\\.\\d+", "flags": "i" }
}
```

```json
{
  "name": "starts_with_json_object",
  "type": "regex_match",
  "config": { "pattern": "^\\s*\\{" }
}
```

```json
{
  "name": "contains_iso_date",
  "type": "regex_match",
  "config": { "pattern": "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}" }
}
```

**Safety:** All regex patterns go through [ReDoS protection](#redos-protection) before execution.

---

### regex_no_match

Output must NOT match a regex pattern. Use for blocking forbidden content, internal URLs, or data leakage.

**Config:** Same as `regex_match`.

**Scoring:** Binary. 1 if the pattern does NOT match, 0 if it does.

```json
{
  "name": "no_internal_urls",
  "type": "regex_no_match",
  "config": { "pattern": "https?://internal\\.", "flags": "i" }
}
```

```json
{
  "name": "no_raw_api_keys",
  "type": "regex_no_match",
  "config": { "pattern": "sk-[a-zA-Z0-9]{20,}" }
}
```

---

### min_length

Output must be at least N characters long. Use to enforce substantive responses.

**Config:**

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `length` | `number` | Yes | Minimum character count |

**Scoring:** Partial credit. If the output is shorter than the minimum, score is `output.length / min`. A 150-character output against a 200-character minimum scores `0.75`.

```json
{
  "name": "substantial_answer",
  "type": "min_length",
  "config": { "length": 200 }
}
```

---

### max_length

Output must be at most N characters long. Use to enforce concise responses or API payload limits.

**Config:**

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `length` | `number` | Yes | Maximum character count |

**Scoring:** Partial credit. If the output exceeds the maximum, score is `max / output.length`. A 600-character output against a 500-character maximum scores `0.833`.

```json
{
  "name": "concise_summary",
  "type": "max_length",
  "config": { "length": 500 }
}
```

---

### contains_keywords

Output must contain specified keywords. Case-insensitive matching.

**Config:**

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `keywords` | `string[]` | Yes | -- | Keywords to look for |
| `threshold` | `number` | No | `1` | Fraction of keywords that must be present (0 to 1) |

**Scoring:** Proportional. Score is `found_count / total_keywords`. If you require 4 keywords and 3 are found, score is `0.75`. The rule passes when the score meets or exceeds the `threshold`.

```json
{
  "name": "covers_required_sections",
  "type": "contains_keywords",
  "config": {
    "keywords": ["summary", "methodology", "results", "conclusion"],
    "threshold": 0.75
  }
}
```

With `threshold: 0.75`, the rule passes if 3 out of 4 keywords are found. The score still reflects the actual ratio (e.g., `0.75` for 3/4).

```json
{
  "name": "mentions_key_terms",
  "type": "contains_keywords",
  "config": {
    "keywords": ["latency", "throughput", "error rate"]
  }
}
```

Without a `threshold`, all keywords must be present (default threshold is `1`).

---

### excludes_keywords

Output must NOT contain any of the specified keywords. Case-insensitive matching.

**Config:**

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `keywords` | `string[]` | Yes | Forbidden keywords |

**Scoring:** Binary. 1 if none found, 0 if any found. The message reports which keywords were detected.

```json
{
  "name": "no_competitor_mentions",
  "type": "excludes_keywords",
  "config": { "keywords": ["acme corp", "rival inc", "othertool"] }
}
```

---

### json_schema

Output must be valid JSON. Parses the output with `JSON.parse()`.

**Config:** No configuration required. Pass an empty object.

**Scoring:** Binary. 1 if the output is valid JSON, 0 if `JSON.parse()` throws.

```json
{
  "name": "valid_json_response",
  "type": "json_schema",
  "config": {}
}
```

Use `json_schema` in combination with `regex_match` or `contains_keywords` to validate both structure and content:

```json
[
  {
    "name": "valid_json",
    "type": "json_schema",
    "config": {},
    "weight": 2
  },
  {
    "name": "has_required_fields",
    "type": "contains_keywords",
    "config": { "keywords": ["\"status\"", "\"data\"", "\"timestamp\""] }
  }
]
```

---

### cost_threshold

Execution cost must be under a USD limit. Reads the `cost_usd` value from the evaluation context.

**Config:**

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `max_cost` | `number` | Yes | Maximum cost in USD |

**Scoring:** Binary. 1 if cost is at or under the threshold, 0 if over.

You must pass `cost_usd` in the `evaluate_output` call for this rule to work:

```json
{
  "output": "The analysis is complete.",
  "eval_type": "custom",
  "cost_usd": 0.03,
  "custom_rules": [
    {
      "name": "budget_limit",
      "type": "cost_threshold",
      "config": { "max_cost": 0.05 },
      "weight": 2
    }
  ]
}
```

---

## Scoring and Weights

### Weighted Average

The final score is a weighted average of all rule scores:

```
score = sum(rule_score * rule_weight) / sum(rule_weight)
```

Example with three rules:

| Rule | Score | Weight | Contribution |
|------|-------|--------|-------------|
| `valid_json` | 1.0 | 2 | 2.0 |
| `min_length` | 0.6 | 1 | 0.6 |
| `has_keywords` | 0.75 | 1.5 | 1.125 |

Final score: `(2.0 + 0.6 + 1.125) / (2 + 1 + 1.5)` = `3.725 / 4.5` = **0.828**

### Pass/Fail Threshold

An evaluation passes when the score is `>= threshold`. The default threshold is `0.7`. Configure it at server initialization:

```typescript
const evalEngine = new EvalEngine(0.85); // stricter threshold
```

### Scoring by Rule Type

| Rule Type | Scoring Model | Partial Credit? |
|-----------|--------------|-----------------|
| `regex_match` | Binary (0 or 1) | No |
| `regex_no_match` | Binary (0 or 1) | No |
| `min_length` | `output.length / min` | Yes |
| `max_length` | `max / output.length` | Yes |
| `contains_keywords` | `found / total` | Yes |
| `excludes_keywords` | Binary (0 or 1) | No |
| `json_schema` | Binary (0 or 1) | No |
| `cost_threshold` | Binary (0 or 1) | No |

### Weight Strategy

Use higher weights for rules that matter more to your use case:

- **Correctness rules** (JSON validity, required fields): weight 2-3
- **Quality rules** (length, keyword coverage): weight 1
- **Nice-to-have rules** (formatting preferences): weight 0.5

The default weight is `1` when omitted.

---

## ReDoS Protection

Every regex pattern passed to `regex_match` or `regex_no_match` is validated before execution.

### What Gets Rejected

1. **Patterns longer than 1000 characters.** Overly long patterns are rejected immediately with the message `Regex pattern too long (N > 1000)`.

2. **Patterns vulnerable to catastrophic backtracking.** Iris uses the [`safe-regex2`](https://www.npmjs.com/package/safe-regex2) library to detect exponential-time patterns. Rejected patterns produce: `Regex pattern rejected: potentially unsafe (catastrophic backtracking)`.

3. **Invalid regex syntax.** Patterns that fail `new RegExp()` are caught with the native error message.

### Examples of Rejected Patterns

These patterns cause exponential backtracking and are rejected:

```
(a+)+$           — nested quantifiers
(a|a)*$          — overlapping alternatives with quantifier
(a+){2,}         — nested quantifiers
(.*a){20}        — greedy quantifier with backreference-like repetition
([a-zA-Z]+)*     — character class with nested quantifier
```

### Examples of Safe Patterns

These patterns are accepted:

```
v\d+\.\d+\.\d+                   — version number
https?://[^\s]+                   — URL detection
\b\d{3}-\d{2}-\d{4}\b            — SSN format
"[a-zA-Z_]+"\s*:\s*              — JSON key pattern
^\s*\{[\s\S]*\}\s*$              — wrapped in braces (non-backtracking)
```

### What Happens on Rejection

When a regex is rejected, the rule returns `passed: false`, `score: 0`, and a message explaining the rejection. The evaluation continues — other rules still run. The rejected rule simply contributes a 0 score at its weight.

---

## Combining Built-in and Custom Rules

Built-in rules (`completeness`, `relevance`, `safety`, `cost`) and custom rules are separate evaluation runs. You cannot mix them in a single `evaluate_output` call. But you can run multiple evaluations against the same output.

### Run Built-in and Custom Sequentially

First, run a built-in safety check:

```json
{
  "output": "Patient records indicate...",
  "eval_type": "safety",
  "trace_id": "trc_abc123"
}
```

Then run domain-specific custom rules against the same output:

```json
{
  "output": "Patient records indicate...",
  "eval_type": "custom",
  "trace_id": "trc_abc123",
  "custom_rules": [
    {
      "name": "no_patient_names",
      "type": "regex_no_match",
      "config": { "pattern": "\\b[A-Z][a-z]+ [A-Z][a-z]+\\b" }
    },
    {
      "name": "has_disclaimer",
      "type": "contains_keywords",
      "config": { "keywords": ["not medical advice", "consult a physician"] }
    }
  ]
}
```

Both evaluations are linked to the same trace via `trace_id` and appear together in the dashboard.

### Extend Built-in Rules Programmatically

Use `registerRule()` to add rules to built-in eval types without replacing them. See [Registering Rules Programmatically](#registering-rules-programmatically).

---

## Registering Rules Programmatically

The `EvalEngine.registerRule()` method adds rules to any built-in eval type. Registered rules run alongside the defaults — they don't replace them.

### API

```typescript
registerRule(evalType: EvalType, rule: EvalRule): void
```

**`EvalType`:** `'completeness' | 'relevance' | 'safety' | 'cost' | 'custom'`

**`EvalRule` interface:**

```typescript
interface EvalRule {
  name: string;
  description: string;
  evalType: EvalType;
  weight: number;
  evaluate(context: EvalContext): EvalRuleResult;
}
```

**`EvalContext`:**

```typescript
interface EvalContext {
  output: string;
  expected?: string;
  input?: string;
  toolCalls?: Array<{ tool_name: string; input?: unknown; output?: unknown }>;
  tokenUsage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  costUsd?: number;
  metadata?: Record<string, unknown>;
  customConfig?: Record<string, unknown>;
}
```

**`EvalRuleResult`:**

```typescript
interface EvalRuleResult {
  ruleName: string;
  passed: boolean;
  score: number;   // 0 to 1
  message: string;
}
```

### Example: Add a Custom Completeness Rule

```typescript
import { EvalEngine } from 'iris-mcp/eval';

const engine = new EvalEngine(0.7);

engine.registerRule('completeness', {
  name: 'has_code_example',
  description: 'Response must include a code block',
  evalType: 'completeness',
  weight: 1.5,
  evaluate(context) {
    const hasCode = /```[\s\S]*?```/.test(context.output);
    return {
      ruleName: 'has_code_example',
      passed: hasCode,
      score: hasCode ? 1 : 0,
      message: hasCode ? 'Code example found' : 'No code example in response',
    };
  },
});

// Now every "completeness" eval includes this rule alongside the 4 built-in ones
const result = engine.evaluate('completeness', { output: '...' });
```

### Example: Add a Custom Safety Rule

```typescript
engine.registerRule('safety', {
  name: 'no_internal_project_names',
  description: 'Output must not leak internal project codenames',
  evalType: 'safety',
  weight: 2,
  evaluate(context) {
    const codenames = ['project-atlas', 'operation-phoenix', 'codename-nebula'];
    const lower = context.output.toLowerCase();
    const found = codenames.filter(name => lower.includes(name));
    return {
      ruleName: 'no_internal_project_names',
      passed: found.length === 0,
      score: found.length === 0 ? 1 : 0,
      message: found.length === 0
        ? 'No internal project names detected'
        : `Leaked project names: ${found.join(', ')}`,
    };
  },
});
```

---

## Reusable Rule Packages

Group related rules into a function that registers them all at once. This pattern lets you share domain-specific rule sets across projects.

### Pattern: Rule Package Function

```typescript
import type { EvalEngine } from 'iris-mcp/eval';

export function registerHipaaRules(engine: EvalEngine): void {
  engine.registerRule('safety', {
    name: 'hipaa_no_phi',
    description: 'Detects Protected Health Information patterns',
    evalType: 'safety',
    weight: 3,
    evaluate(context) {
      const patterns = [
        { name: 'MRN', regex: /\bMRN[:\s]*\d{6,}\b/i },
        { name: 'DOB', regex: /\b(?:DOB|date of birth)[:\s]*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/i },
        { name: 'Diagnosis Code', regex: /\b[A-Z]\d{2}\.\d{1,4}\b/ },
      ];
      const found = patterns.filter(p => p.regex.test(context.output)).map(p => p.name);
      return {
        ruleName: 'hipaa_no_phi',
        passed: found.length === 0,
        score: found.length === 0 ? 1 : 0,
        message: found.length === 0
          ? 'No PHI patterns detected'
          : `PHI detected: ${found.join(', ')}`,
      };
    },
  });

  engine.registerRule('safety', {
    name: 'hipaa_disclaimer_present',
    description: 'Response must include HIPAA-appropriate disclaimer',
    evalType: 'safety',
    weight: 2,
    evaluate(context) {
      const lower = context.output.toLowerCase();
      const hasDisclaimer = lower.includes('not medical advice') ||
        lower.includes('consult your healthcare provider') ||
        lower.includes('hipaa');
      return {
        ruleName: 'hipaa_disclaimer_present',
        passed: hasDisclaimer,
        score: hasDisclaimer ? 1 : 0,
        message: hasDisclaimer
          ? 'HIPAA-appropriate disclaimer found'
          : 'Missing HIPAA disclaimer',
      };
    },
  });
}
```

### Usage

```typescript
import { EvalEngine } from 'iris-mcp/eval';
import { registerHipaaRules } from './rules/hipaa.js';

const engine = new EvalEngine(0.8);
registerHipaaRules(engine);

// Safety evals now include the 3 built-in safety rules + 2 HIPAA rules
```

### Pattern: Rule Package as a Config Array

For teams that prefer JSON configuration over code, export rule definitions as `CustomRuleDefinition[]` arrays:

```typescript
import type { CustomRuleDefinition } from 'iris-mcp/types/eval';

export const financialAccuracyRules: CustomRuleDefinition[] = [
  {
    name: 'valid_json_output',
    type: 'json_schema',
    config: {},
    weight: 2,
  },
  {
    name: 'has_currency_format',
    type: 'regex_match',
    config: { pattern: '\\$[\\d,]+\\.\\d{2}', flags: '' },
    weight: 1.5,
  },
  {
    name: 'no_approximations',
    type: 'excludes_keywords',
    config: { keywords: ['approximately', 'roughly', 'about', 'around', 'estimated'] },
    weight: 1,
  },
  {
    name: 'budget_per_call',
    type: 'cost_threshold',
    config: { max_cost: 0.02 },
    weight: 2,
  },
];
```

Then pass the array directly:

```json
{
  "output": "{\"total\": \"$1,234.56\", \"tax\": \"$98.77\"}",
  "eval_type": "custom",
  "cost_usd": 0.015,
  "custom_rules": [
    { "name": "valid_json_output", "type": "json_schema", "config": {}, "weight": 2 },
    { "name": "has_currency_format", "type": "regex_match", "config": { "pattern": "\\$[\\d,]+\\.\\d{2}" }, "weight": 1.5 },
    { "name": "no_approximations", "type": "excludes_keywords", "config": { "keywords": ["approximately", "roughly", "about", "around", "estimated"] } },
    { "name": "budget_per_call", "type": "cost_threshold", "config": { "max_cost": 0.02 }, "weight": 2 }
  ]
}
```

---

## Real-World Examples

### HIPAA Compliance Check

A healthcare agent must not leak Protected Health Information and should include appropriate disclaimers.

```json
{
  "output": "Based on the symptoms described, this could indicate a respiratory infection. Treatment options include rest, fluids, and over-the-counter medications. This information is not medical advice — consult your healthcare provider for diagnosis and treatment.",
  "eval_type": "custom",
  "custom_rules": [
    {
      "name": "no_ssn",
      "type": "regex_no_match",
      "config": { "pattern": "\\b\\d{3}-\\d{2}-\\d{4}\\b" },
      "weight": 3
    },
    {
      "name": "no_mrn",
      "type": "regex_no_match",
      "config": { "pattern": "\\bMRN[:\\s]*\\d{6,}\\b", "flags": "i" },
      "weight": 3
    },
    {
      "name": "no_dob_pattern",
      "type": "regex_no_match",
      "config": { "pattern": "\\b(?:DOB|date of birth)[:\\s]*\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}\\b", "flags": "i" },
      "weight": 3
    },
    {
      "name": "no_patient_identifiers",
      "type": "excludes_keywords",
      "config": { "keywords": ["patient name", "medical record", "insurance id", "policy number"] },
      "weight": 2
    },
    {
      "name": "has_disclaimer",
      "type": "contains_keywords",
      "config": {
        "keywords": ["not medical advice", "consult"],
        "threshold": 0.5
      },
      "weight": 2
    },
    {
      "name": "sufficient_detail",
      "type": "min_length",
      "config": { "length": 100 },
      "weight": 1
    }
  ]
}
```

**What this catches:**
- SSN patterns (weight 3)
- Medical Record Numbers (weight 3)
- Date of birth in identifiable format (weight 3)
- Common patient identifier phrases (weight 2)
- Missing medical disclaimer (weight 2)
- Trivially short responses (weight 1)

---

### Financial Accuracy Validation

A financial reporting agent must produce exact numbers, proper currency formatting, and stay within a per-call budget.

```json
{
  "output": "{\"revenue\": \"$1,234,567.89\", \"expenses\": \"$987,654.32\", \"net_income\": \"$246,913.57\", \"period\": \"Q1 2026\"}",
  "eval_type": "custom",
  "cost_usd": 0.018,
  "custom_rules": [
    {
      "name": "valid_json",
      "type": "json_schema",
      "config": {},
      "weight": 3
    },
    {
      "name": "proper_currency_format",
      "type": "regex_match",
      "config": { "pattern": "\\$[\\d,]+\\.\\d{2}" },
      "weight": 2
    },
    {
      "name": "no_vague_language",
      "type": "excludes_keywords",
      "config": {
        "keywords": ["approximately", "roughly", "about", "around", "estimated", "ballpark", "in the range of"]
      },
      "weight": 2
    },
    {
      "name": "has_required_fields",
      "type": "contains_keywords",
      "config": {
        "keywords": ["revenue", "expenses", "net_income"],
        "threshold": 1
      },
      "weight": 2
    },
    {
      "name": "no_stale_data_warning",
      "type": "regex_no_match",
      "config": { "pattern": "(?:data may be|information might be) (?:outdated|stale)", "flags": "i" },
      "weight": 1.5
    },
    {
      "name": "cost_budget",
      "type": "cost_threshold",
      "config": { "max_cost": 0.05 },
      "weight": 2
    }
  ]
}
```

**What this catches:**
- Malformed JSON output (weight 3)
- Missing dollar sign or decimal places in currency (weight 2)
- Hedging language that undermines financial precision (weight 2)
- Missing required financial fields (weight 2)
- "Data may be outdated" disclaimers that shouldn't appear in production reports (weight 1.5)
- Runaway costs per call (weight 2)

---

### Brand Voice Enforcement

A customer-facing agent must follow brand guidelines: no competitor mentions, required tone markers, proper formatting, and concise responses.

```json
{
  "output": "Here's how to set up your integration:\n\n1. Install the package: `npm install acme-sdk`\n2. Add your API key to the configuration file\n3. Run the setup wizard: `acme init`\n\nIf you run into issues, our support team is available at support@acme.com. We typically respond within 2 hours during business hours.",
  "eval_type": "custom",
  "custom_rules": [
    {
      "name": "no_competitor_mentions",
      "type": "excludes_keywords",
      "config": {
        "keywords": ["competitor-a", "competitor-b", "rival-tool", "alternative-product"]
      },
      "weight": 3
    },
    {
      "name": "no_ai_hedging",
      "type": "excludes_keywords",
      "config": {
        "keywords": ["as an ai", "i cannot", "i apologize", "i'm not able to", "i don't have access"]
      },
      "weight": 2
    },
    {
      "name": "professional_tone",
      "type": "excludes_keywords",
      "config": {
        "keywords": ["lol", "haha", "omg", "btw", "tbh", "gonna", "wanna"]
      },
      "weight": 1.5
    },
    {
      "name": "actionable_content",
      "type": "contains_keywords",
      "config": {
        "keywords": ["install", "configure", "run", "setup", "add"],
        "threshold": 0.4
      },
      "weight": 1
    },
    {
      "name": "not_too_short",
      "type": "min_length",
      "config": { "length": 100 },
      "weight": 1
    },
    {
      "name": "not_too_long",
      "type": "max_length",
      "config": { "length": 2000 },
      "weight": 1
    },
    {
      "name": "no_internal_urls",
      "type": "regex_no_match",
      "config": { "pattern": "https?://(?:internal|staging|dev)\\.", "flags": "i" },
      "weight": 2
    }
  ]
}
```

**What this catches:**
- Competitor name-drops (weight 3)
- AI assistant hedging that breaks character (weight 2)
- Informal language that doesn't match brand voice (weight 1.5)
- Internal/staging URLs leaking to customers (weight 2)
- Responses that are too short to be useful or too long to read (weight 1 each)
- Missing actionable language in how-to responses (weight 1)
