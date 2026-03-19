import { IrisLogo } from "./iris-logo";

export function Footer(): React.ReactElement {
  return (
    <footer className="border-t border-border-subtle">
      {/* CTA band (like Ripple's "Ready to get started?" / LangChain's "Get started with LangSmith") */}
      <div className="relative overflow-hidden bg-bg-raised py-24 lg:py-32">
        <div className="hero-glow absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-25" aria-hidden="true" />
        <div className="relative mx-auto max-w-3xl px-6 text-center lg:px-8">
          <h2 className="font-display text-3xl font-extrabold tracking-tight text-text-primary md:text-5xl">
            Get started with <span className="text-gradient">Iris</span>
          </h2>
          <p className="mt-5 text-lg text-text-secondary">
            See what your AI agents are actually doing. One command. No SDK.
            Open-source core. MIT licensed.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <a
              href="#open-source"
              className="group inline-flex items-center rounded-xl bg-iris-600 px-8 py-4 text-[15px] font-semibold text-white shadow-lg shadow-iris-600/20 transition-all hover:bg-iris-500 hover:shadow-iris-500/30"
            >
              Start building
              <svg className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-0.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
            </a>
            <a
              href="https://github.com/iris-eval/mcp-server"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-xl border border-border-default px-8 py-4 text-[15px] font-semibold text-text-secondary transition-all hover:border-border-glow hover:text-text-primary"
            >
              Star on GitHub
            </a>
          </div>
        </div>
      </div>

      {/* Footer links */}
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-8 lg:py-16">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="max-w-xs">
            <div className="flex items-center gap-2.5">
              <IrisLogo size={28} />
              <span className="font-display text-lg font-bold text-text-primary">
                Iris
              </span>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-text-muted">
              The agent eval standard for MCP. Open-source core. MIT
              Licensed.
            </p>
          </div>

          <div className="flex flex-wrap gap-12 lg:gap-16">
            <div>
              <h4 className="text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted">
                Product
              </h4>
              <ul className="mt-4 space-y-3 text-[13px]">
                {[
                  { label: "Features", href: "/#product" },
                  { label: "Playground", href: "/playground" },
                  { label: "Pricing", href: "/#pricing" },
                  { label: "Blog", href: "/blog" },
                  { label: "Quick Start", href: "/#open-source" },
                  { label: "Roadmap", href: "/#roadmap" },
                ].map((l) => (
                  <li key={l.label}>
                    <a href={l.href} className="text-text-secondary transition-colors hover:text-text-primary">{l.label}</a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted">
                Compare
              </h4>
              <ul className="mt-4 space-y-3 text-[13px]">
                {[
                  { label: "Iris vs Langfuse", href: "/compare/langfuse" },
                  { label: "Iris vs LangSmith", href: "/compare/langsmith" },
                  { label: "Iris vs Helicone", href: "/compare/helicone" },
                  { label: "Iris vs Braintrust", href: "/compare/braintrust" },
                  { label: "Iris vs Arize", href: "/compare/arize" },
                ].map((l) => (
                  <li key={l.label}>
                    <a href={l.href} className="text-text-secondary transition-colors hover:text-text-primary">{l.label}</a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted">
                Community
              </h4>
              <ul className="mt-4 space-y-3 text-[13px]">
                {[
                  { label: "GitHub", href: "https://github.com/iris-eval/mcp-server", ext: true },
                  { label: "Discord (coming soon)", href: "#", ext: false },
                  { label: "npm", href: "https://www.npmjs.com/package/@iris-eval/mcp-server", ext: true },
                  { label: "@iris_eval", href: "https://x.com/iris_eval", ext: true },
                ].map((l) => (
                  <li key={l.label}>
                    <a href={l.href} target="_blank" rel="noopener noreferrer" className="text-text-secondary transition-colors hover:text-text-primary">{l.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-border-subtle pt-8 text-[12px] text-text-muted md:flex-row">
          <span>&copy; 2026 Iris. MIT Licensed.</span>
          <div className="flex items-center gap-4">
            <a href="/privacy" className="transition-colors hover:text-text-secondary">Privacy</a>
            <a href="/terms" className="transition-colors hover:text-text-secondary">Terms</a>
            <a href="mailto:hello@iris-eval.com" className="transition-colors hover:text-text-secondary">hello@iris-eval.com</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
