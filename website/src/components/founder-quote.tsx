export function FounderQuote(): React.ReactElement {
  return (
    <section className="relative overflow-hidden py-28 lg:py-36">
      <div className="hero-glow absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-20" aria-hidden="true" />
      <div className="relative mx-auto max-w-4xl px-6 lg:px-8">
        <blockquote className="text-center">
          <div className="font-display text-6xl font-bold leading-none text-border-default select-none md:text-8xl">
            &ldquo;
          </div>
          <p className="mt-4 text-xl leading-relaxed text-text-secondary italic md:text-2xl">
            I kept running into the same problem building AI agents: once
            they&apos;re running, you have no visibility into what they&apos;re
            actually doing. Traditional monitoring tells you the request
            succeeded. It can&apos;t tell you the agent leaked PII, hallucinated
            an answer, or burned through your budget on a single query.
          </p>
          <p className="mt-6 text-xl leading-relaxed text-text-secondary italic md:text-2xl">
            So I built Iris — an MCP server that any agent discovers and uses
            automatically. No SDK. No code changes. Just add it to your config
            and start seeing everything.
          </p>
          <footer className="mt-10 flex flex-col items-center gap-1">
            <div className="text-[15px] font-bold text-text-primary">
              Ian Parent
            </div>
            <div className="text-[13px] text-text-muted">
              Founder &amp; Builder
            </div>
          </footer>
        </blockquote>
      </div>
    </section>
  );
}
