"use client";

/*
 * LivePlayground (B5) — paste output, pick category, see real rule results.
 *
 * Calls POST /api/playground/eval which runs the vendored Iris
 * rule library server-side. Every result includes a one-line message
 * explaining why the rule passed or failed.
 */
import { useState } from "react";
import { PRESETS } from "./presets";

type EvalCategory = "safety" | "relevance" | "completeness" | "cost" | "all";

interface RuleResult {
  ruleName: string;
  category: string;
  passed: boolean;
  score: number;
  message: string;
  skipped?: boolean;
  skipReason?: string;
}

interface EvalSummary {
  ruleResults: RuleResult[];
  passed: boolean;
  score: number;
  totalRules: number;
  passedRules: number;
  skippedRules: number;
  vendoredFromVersion: string;
}

type RuleCounts = Record<Exclude<EvalCategory, "all">, number>;

function categoryOptions(counts: RuleCounts): Array<{ value: EvalCategory; label: string }> {
  return [
    { value: "all", label: "All categories" },
    { value: "safety", label: `Safety only (${counts.safety} rules)` },
    { value: "relevance", label: `Relevance only (${counts.relevance} rules)` },
    { value: "completeness", label: `Completeness only (${counts.completeness} rules)` },
    { value: "cost", label: `Cost only (${counts.cost} rules)` },
  ];
}

/**
 * `ruleCounts` comes from the server component that renders this page,
 * read off the vendored registry — the labels are never typed by hand.
 */
export function LivePlayground({ ruleCounts }: { ruleCounts: RuleCounts }): React.ReactElement {
  const CATEGORY_OPTIONS = categoryOptions(ruleCounts);
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [expected, setExpected] = useState("");
  const [category, setCategory] = useState<EvalCategory>("all");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EvalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setOutput(preset.output);
    setInput(preset.input ?? "");
    setExpected(preset.expected ?? "");
    setCategory(preset.category);
    setResult(null);
    setError(null);
  };

  const onRun = async () => {
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await fetch("/api/playground/eval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          output,
          input: input || undefined,
          expected: expected || undefined,
          category,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(data as EvalSummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  const canRun = output.trim().length > 0 && !loading;

  return (
    <section className="mx-auto max-w-6xl px-6 py-16 lg:px-8 lg:py-24">
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
          Live Playground
        </p>
        <h1 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">
          Paste any output. <span className="text-gradient">See the real rules score it.</span>
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-text-secondary">
          Runs the same Iris rule library that ships in the npm package — server-side,
          no install, instant. 15 rules across safety, relevance, completeness, and cost — the two that read an agent’s tool calls skip here, because this page takes text only.
        </p>
      </div>

      <div className="mx-auto mt-10 grid max-w-5xl grid-cols-1 gap-8 lg:grid-cols-2">
        {/* Form */}
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.15em] text-text-muted">
              Try a preset
            </p>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="rounded-md border border-border-default bg-bg-surface px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:border-iris-500 hover:text-text-primary"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold uppercase tracking-[0.15em] text-text-muted">
              Output (required)
            </span>
            <textarea
              value={output}
              onChange={(e) => setOutput(e.target.value)}
              placeholder="Paste an agent output to score…"
              rows={8}
              className="w-full rounded-md border border-border-default bg-bg-surface p-3 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:border-iris-500 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold uppercase tracking-[0.15em] text-text-muted">
              Input (optional — required for relevance rules)
            </span>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="The user prompt the agent received…"
              rows={3}
              className="w-full rounded-md border border-border-default bg-bg-surface p-3 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:border-iris-500 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold uppercase tracking-[0.15em] text-text-muted">
              Expected output (optional — required for expected_coverage)
            </span>
            <input
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              placeholder="Keywords or phrases that should appear…"
              className="w-full rounded-md border border-border-default bg-bg-surface p-3 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:border-iris-500 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold uppercase tracking-[0.15em] text-text-muted">
              Categories
            </span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as EvalCategory)}
              className="rounded-md border border-border-default bg-bg-surface p-2.5 text-[13px] text-text-primary focus:border-iris-500 focus:outline-none"
            >
              {CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={onRun}
            disabled={!canRun}
            className="rounded-xl bg-iris-600 px-6 py-3 font-semibold text-white shadow-lg shadow-iris-600/20 transition-all enabled:hover:bg-iris-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Evaluating…" : "Run evaluation"}
          </button>
        </div>

        {/* Results */}
        <div className="flex flex-col gap-4">
          <p className="text-[12px] font-semibold uppercase tracking-[0.15em] text-text-muted">
            Results
          </p>
          {!result && !error && !loading && (
            <div className="rounded-lg border border-dashed border-border-default bg-bg-surface/50 p-8 text-center text-text-muted">
              Paste output + click &ldquo;Run evaluation&rdquo; to see rule results here.
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-eval-fail bg-eval-fail/10 p-4 text-eval-fail">
              <strong>Error:</strong> {error}
            </div>
          )}
          {result && (
            <>
              <div className="flex items-center justify-between rounded-lg border border-border-default bg-bg-surface p-4">
                <div>
                  <p className="text-[12px] uppercase tracking-[0.1em] text-text-muted">Verdict</p>
                  <p
                    className={`text-2xl font-bold ${result.passed ? "text-eval-pass" : "text-eval-fail"}`}
                  >
                    {result.passed ? "PASS" : "FAIL"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[12px] uppercase tracking-[0.1em] text-text-muted">
                    {result.passedRules} of {result.totalRules} judged rules pass
                    {result.skippedRules > 0 ? ` · ${result.skippedRules} skipped` : ""}
                  </p>
                  <p className="font-mono text-2xl font-bold text-text-primary">
                    {(result.score * 100).toFixed(0)}%
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {result.ruleResults.map((r) => (
                  <div
                    key={r.ruleName}
                    className={`rounded-md border p-3 ${
                      r.skipped
                        ? "border-dashed border-border-default bg-surface-primary"
                        : r.passed
                          ? "border-eval-pass/30 bg-eval-pass/5"
                          : "border-eval-fail/40 bg-eval-fail/10"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <code className="font-mono text-[13px] font-semibold text-text-primary">
                        {r.ruleName}
                      </code>
                      <span
                        className={`text-[11px] font-bold uppercase ${
                          r.skipped ? "text-text-muted" : r.passed ? "text-eval-pass" : "text-eval-fail"
                        }`}
                      >
                        {r.skipped ? "SKIPPED" : r.passed ? "PASS" : "FAIL"} · {r.category}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] text-text-secondary">
                      {r.skipped ? `Not judged: ${r.skipReason ?? r.message}. The installed server skips it the same way.` : r.message}
                    </p>
                  </div>
                ))}
              </div>
              <p className="text-center text-[11px] text-text-muted">
                Vendored from Iris {result.vendoredFromVersion}. The playground
                runs a reduced safety pattern set — the installed server checks
                more patterns, so it catches strictly more than you see here.
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
