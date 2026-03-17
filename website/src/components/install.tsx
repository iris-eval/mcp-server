export function Install(): React.ReactElement {
  return (
    <section className="relative py-32 lg:py-44" id="open-source">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
            Open Source — Free Forever to Self-Host
          </p>
          <h2 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl lg:text-6xl">
            60 seconds to{" "}
            <span className="text-gradient">first trace.</span>
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-text-secondary md:text-xl">
            Install Iris locally and start seeing what your agents are doing.
            Works with Claude Desktop, Cursor, Windsurf, or any MCP-compatible
            agent. Free, MIT-licensed, your data stays on your machine.
          </p>
        </div>

        <div className="mt-16 grid gap-8 lg:mt-20 lg:grid-cols-2">
          {/* MCP Config */}
          <div className="card-premium overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border-subtle px-6 py-4">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 font-mono text-[12px] text-text-muted">
                claude_desktop_config.json
              </span>
            </div>
            <div className="p-6">
              <pre className="overflow-x-auto font-mono text-[13px] leading-[1.8]">
                <code>
                  <span className="text-text-muted">{"{"}</span>{"\n"}
                  {"  "}<span className="text-eval-pass">&quot;mcpServers&quot;</span><span className="text-text-muted">: {"{"}</span>{"\n"}
                  {"    "}<span className="text-eval-pass">&quot;iris-eval&quot;</span><span className="text-text-muted">: {"{"}</span>{"\n"}
                  {"      "}<span className="text-eval-pass">&quot;command&quot;</span><span className="text-text-muted">: </span><span className="text-text-accent">&quot;npx&quot;</span><span className="text-text-muted">,</span>{"\n"}
                  {"      "}<span className="text-eval-pass">&quot;args&quot;</span><span className="text-text-muted">: [</span><span className="text-text-accent">&quot;@iris-eval/mcp-server&quot;</span><span className="text-text-muted">]</span>{"\n"}
                  {"    "}<span className="text-text-muted">{"}"}</span>{"\n"}
                  {"  "}<span className="text-text-muted">{"}"}</span>{"\n"}
                  <span className="text-text-muted">{"}"}</span>
                </code>
              </pre>
            </div>
          </div>

          {/* Terminal */}
          <div className="card-premium overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border-subtle px-6 py-4">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 font-mono text-[12px] text-text-muted">
                Terminal
              </span>
            </div>
            <div className="p-6">
              <pre className="overflow-x-auto font-mono text-[13px] leading-[2.2]">
                <code>
                  <span className="text-text-muted">$ </span><span className="text-text-primary">npm install -g @iris-eval/mcp-server</span>{"\n"}
                  <span className="text-text-muted">$ </span><span className="text-text-primary">iris-mcp --dashboard</span>{"\n"}
                  <span className="text-eval-pass">✓ Dashboard running at http://localhost:3838</span>
                </code>
              </pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
