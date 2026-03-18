export function CompareDisclaimer({ lastVerified, competitor }: { lastVerified: string; competitor: string }): React.ReactElement {
  return (
    <div className="mx-auto max-w-5xl px-6 pb-12">
      <div className="rounded-xl border border-border-subtle bg-bg-card/50 px-6 py-4 text-[12px] leading-relaxed text-text-muted">
        <p>
          <strong className="text-text-secondary">Last verified:</strong>{" "}
          {lastVerified}. This comparison is based on publicly available
          documentation and may not reflect recent changes to {competitor}.
          We aim to keep this page accurate and fair.
        </p>
        <p className="mt-2">
          See something outdated or incorrect?{" "}
          <a
            href={`https://github.com/iris-eval/mcp-server/issues/new?title=Compare+page+update:+${encodeURIComponent(competitor)}&labels=documentation&body=Which+claim+is+incorrect+and+what+is+the+current+state%3F`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-accent underline transition-colors hover:text-iris-400"
          >
            Report an inaccuracy
          </a>{" "}
          — we review and update within 48 hours.
        </p>
      </div>
    </div>
  );
}
