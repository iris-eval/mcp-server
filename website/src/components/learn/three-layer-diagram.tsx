export function ThreeLayerDiagram(): React.ReactElement {
  return (
    <div className="my-10 mx-auto max-w-2xl">
      <div className="flex flex-col gap-3">
        {/* Layer 3 — Output Quality (Iris) */}
        <div className="rounded-xl border-2 border-iris-500/60 bg-iris-500/8 px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-iris-400">
                Layer 3 — Output Quality
              </p>
              <p className="mt-1.5 font-display text-lg font-bold text-text-primary">
                Was the output correct?
              </p>
              <p className="mt-1 text-[13px] text-text-muted">
                Quality scoring, safety checks, cost thresholds
              </p>
            </div>
            <span className="shrink-0 rounded-lg bg-iris-600/20 px-3 py-1.5 font-display text-sm font-bold text-iris-400">
              Iris
            </span>
          </div>
        </div>

        {/* Arrow */}
        <div className="flex justify-center text-text-muted">
          <svg width="20" height="12" viewBox="0 0 20 12" fill="none">
            <path d="M10 0L10 12M10 12L5 7M10 12L15 7" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>

        {/* Layer 2 — Protocol */}
        <div className="rounded-xl border border-border-default bg-bg-card px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-text-muted">
                Layer 2 — Protocol
              </p>
              <p className="mt-1.5 font-display text-lg font-bold text-text-primary">
                What did the agent do?
              </p>
              <p className="mt-1 text-[13px] text-text-muted">
                MCP call completion, tool invocations, message routing
              </p>
            </div>
            <span className="shrink-0 rounded-lg bg-bg-base px-3 py-1.5 text-[13px] text-text-muted">
              Emerging
            </span>
          </div>
        </div>

        {/* Arrow */}
        <div className="flex justify-center text-text-muted">
          <svg width="20" height="12" viewBox="0 0 20 12" fill="none">
            <path d="M10 0L10 12M10 12L5 7M10 12L15 7" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>

        {/* Layer 1 — Infrastructure */}
        <div className="rounded-xl border border-border-default bg-bg-card px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-text-muted">
                Layer 1 — Infrastructure
              </p>
              <p className="mt-1.5 font-display text-lg font-bold text-text-primary">
                Did the request succeed?
              </p>
              <p className="mt-1 text-[13px] text-text-muted">
                Uptime, latency, error rates, resource utilization
              </p>
            </div>
            <span className="shrink-0 rounded-lg bg-bg-base px-3 py-1.5 text-[13px] text-text-muted">
              Established
            </span>
          </div>
        </div>
      </div>

      <p className="mt-5 text-center text-[13px] text-text-muted">
        Most teams have Layer 1. Emerging teams have Layer 2.{" "}
        <strong className="text-text-secondary">The missing layer is Layer 3.</strong>
      </p>
    </div>
  );
}
