"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useTheme } from "./theme-provider";
import { IrisLogo } from "./iris-logo";
import { CURRENT_RELEASE_HEADLINE, PUBLIC_REPO_URL, VERSION_MCP_SERVER } from "@/lib/claims";

const NAV_LINKS = [
  { label: "Product", href: "/#product" },
  { label: "Playground", href: "/playground" },
  { label: "Proof", href: "/proof" },
  { label: "Learn", href: "/learn" },
  { label: "Compare", href: "/compare" },
  { label: "Pricing", href: "/pricing" },
  { label: "Blog", href: "/blog" },
  { label: "Open Source", href: "/#open-source" },
  { label: "Roadmap", href: "/#roadmap" },
] as const;

export function Nav(): React.ReactElement {
  const { theme, toggle } = useTheme();
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handler = (): void => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);

  return (
    <>
      {/* Event banner - every word here derives from .claims.json. The
          previous banner hardcoded the prior release's version and feature
          list as prose beside a pill that rendered the live version, so the
          public site read "v0.5.0" next to "v0.4" for two releases. The
          headline is the CHANGELOG's own bold lead line for the current
          release; the link goes to that release's notes. */}
      <div className="relative z-50 border-b border-border-subtle bg-iris-600/8 px-4 py-2.5 text-center">
        <a href={`${PUBLIC_REPO_URL}/releases/tag/v${VERSION_MCP_SERVER}`} target="_blank" rel="noopener noreferrer" className="inline-flex flex-wrap items-center justify-center gap-2 text-sm text-text-secondary transition-colors hover:text-text-primary">
          <span className="rounded-full bg-iris-600 px-2 py-0.5 text-[11px] font-semibold text-white">v{VERSION_MCP_SERVER}</span>
          <span>
            {CURRENT_RELEASE_HEADLINE ?? `Iris v${VERSION_MCP_SERVER} is out`}
            <span className="hidden sm:inline"> — read the release notes</span>
          </span>
          <span className="text-text-accent">&rarr;</span>
        </a>
      </div>

      <header className={`sticky top-0 z-40 transition-all duration-300 ${scrolled ? "border-b border-border-subtle bg-bg-base/80 backdrop-blur-xl" : "bg-transparent"}`}>
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 lg:px-8" aria-label="Primary">
          <Link href="/" className="flex items-center gap-2.5">
            <IrisLogo size={30} />
            <span className="font-display text-[22px] font-bold tracking-tight text-text-primary">Iris</span>
          </Link>

          <div className="hidden items-center gap-1 md:flex">
            {NAV_LINKS.map((l) => (
              <a key={l.href} href={l.href} className="rounded-lg px-4 py-2 text-[14px] font-medium text-text-secondary transition-colors hover:bg-border-subtle hover:text-text-primary">{l.label}</a>
            ))}
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <button onClick={toggle} className="rounded-lg p-2.5 text-text-muted transition-colors hover:bg-border-subtle hover:text-text-primary" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
              {theme === "dark" ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              )}
            </button>
            <a href="https://github.com/iris-eval/mcp-server" target="_blank" rel="noopener noreferrer" className="rounded-lg px-4 py-2 text-[14px] font-medium text-text-secondary transition-colors hover:bg-border-subtle hover:text-text-primary">GitHub</a>
            <Link href="/#open-source" className="rounded-lg bg-iris-600 px-5 py-2.5 text-[14px] font-semibold text-white shadow-sm shadow-iris-600/20 transition-all hover:bg-iris-500">Get Started</Link>
          </div>

          <button onClick={() => setMobileOpen(!mobileOpen)} className="rounded-lg p-2 text-text-secondary md:hidden" aria-label="Toggle menu" aria-expanded={mobileOpen}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {mobileOpen ? <path d="M18 6L6 18M6 6l12 12" /> : <path d="M3 12h18M3 6h18M3 18h18" />}
            </svg>
          </button>
        </nav>

        {mobileOpen && (
          <div className="border-t border-border-subtle bg-bg-base px-6 pb-8 md:hidden">
            <div className="flex flex-col gap-2 pt-4">
              {NAV_LINKS.map((l) => (
                <a key={l.href} href={l.href} onClick={() => setMobileOpen(false)} className="rounded-lg px-4 py-3 text-[15px] font-medium text-text-secondary transition-colors hover:bg-border-subtle">{l.label}</a>
              ))}
              <div className="mt-4 flex flex-col gap-3 border-t border-border-subtle pt-4">
                <button onClick={toggle} className="rounded-lg px-4 py-3 text-left text-[15px] text-text-secondary hover:bg-border-subtle">
                  {theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                </button>
                <Link href="/#open-source" onClick={() => setMobileOpen(false)} className="rounded-lg bg-iris-600 px-5 py-3 text-center text-[15px] font-semibold text-white">Get Started</Link>
              </div>
            </div>
          </div>
        )}
      </header>
    </>
  );
}
