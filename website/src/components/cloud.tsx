"use client";

import { useState, useEffect } from "react";
import { motion, useReducedMotion, useInView } from "framer-motion";
import { useRef } from "react";

const TIERS = [
  {
    name: "Self-Hosted",
    badge: "Open Source",
    price: "$0",
    period: "forever",
    description: "Everything you need to evaluate your MCP agents in production. Your machine, your data, your eval rules.",
    cta: { label: "Get Started", href: "#open-source" },
    highlight: false,
    features: [
      "7 MCP tools — full lifecycle (log, evaluate, query, deploy/delete rules, delete traces)",
      "13 built-in eval rules + custom rules",
      "Web dashboard with trace visualization",
      "SQLite storage — zero infrastructure",
      "Production security (auth, rate limiting)",
      "Cost tracking per trace",
      "Docker + npm + npx install",
      "Community support (GitHub + Discord)",
    ],
  },
  {
    name: "Cloud Starter",
    badge: "Free",
    price: "$0",
    period: "/month",
    description: "Run evaluations in the cloud with no commitment. Same eval engine, managed for you. No credit card.",
    cta: { label: "Join Waitlist", href: "#waitlist" },
    highlight: false,
    coming: true,
    features: [
      "Everything in Self-Hosted, plus:",
      "10,000 evaluations / month",
      "7-day eval history",
      "1 team member",
      "Managed PostgreSQL",
      "Personal dashboard",
      "No credit card required",
    ],
  },
  {
    name: "Cloud Pro",
    badge: "Most Popular",
    price: "$49",
    period: "/month",
    description: "For teams that need shared eval results, alerting on quality regressions, and room to scale.",
    cta: { label: "Join Waitlist", href: "#waitlist" },
    highlight: true,
    coming: true,
    features: [
      "Everything in Starter, plus:",
      "25,000 evaluations included",
      "$0.005 per additional evaluation",
      "90-day eval history",
      "Unlimited team members",
      "Team dashboards with shared views",
      "Alerting (webhook + email)",
      "API key management",
      "CSV / JSON data export",
      "Priority support",
    ],
  },
  {
    name: "Enterprise",
    badge: "Custom",
    price: "Custom",
    period: "",
    description: "For organizations that need audit-grade evaluation records, compliance, and dedicated support.",
    cta: { label: "Contact Us", href: "mailto:hello@iris-eval.com" },
    highlight: false,
    coming: true,
    features: [
      "Everything in Pro, plus:",
      "SSO / SAML (Okta, Azure AD, Google)",
      "RBAC with custom roles",
      "Audit logs with export",
      "SOC 2 Type II documentation",
      "Custom retention policies",
      "SLA with uptime guarantee",
      "Dedicated support + onboarding",
      "EU AI Act compliance support",
    ],
  },
];

export function Pricing(): React.ReactElement {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [waitlistCount, setWaitlistCount] = useState<number | null>(null);
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  const reduce = useReducedMotion();

  useEffect(() => {
    fetch("/api/waitlist-count")
      .then((res) => res.json())
      .then((data) => {
        if (data.count > 0) setWaitlistCount(data.count);
      })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!email) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (res.ok) {
        setSubmitted(true);
      } else if (res.status === 429) {
        setError("Too many attempts. Try again later.");
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Something went wrong. Please try again.");
      }
    } catch {
      // Network failure fallback — store locally
      const list = JSON.parse(localStorage.getItem("iris-waitlist") || "[]");
      if (!list.includes(email)) {
        list.push(email);
        localStorage.setItem("iris-waitlist", JSON.stringify(list));
      }
      setSubmitted(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section ref={ref} className="relative bg-bg-raised py-32 lg:py-44" id="pricing">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        {/* Header */}
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
            Pricing
          </p>
          <h2 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl lg:text-6xl">
            Free to self-host.{" "}
            <span className="text-gradient">Cloud when you&apos;re ready.</span>
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-text-secondary md:text-xl">
            The open-source core is MIT licensed with no limits. The cloud adds
            team dashboards, alerting, and managed infrastructure — starting
            free.
          </p>
        </div>

        {/* Tier cards */}
        <div className="mt-16 grid gap-6 lg:mt-20 lg:grid-cols-4">
          {TIERS.map((tier, i) => (
            <motion.div
              key={tier.name}
              initial={reduce ? {} : { opacity: 0, y: 20 }}
              animate={inView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              className={`relative flex flex-col rounded-2xl p-6 ${
                tier.highlight
                  ? ""
                  : "card-premium"
              }`}
              style={
                tier.highlight
                  ? {
                      background: "var(--bg-card)",
                      border: "1px solid var(--border-glow)",
                      boxShadow: "0 0 48px var(--glow-primary), 0 8px 32px rgba(0,0,0,0.2)",
                    }
                  : undefined
              }
            >
              {/* Badge */}
              <div className="mb-4 flex items-center gap-2">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                    tier.highlight
                      ? "bg-iris-600 text-white"
                      : tier.badge === "Free"
                        ? "bg-eval-pass/10 text-eval-pass"
                        : tier.badge === "Open Source"
                          ? "bg-iris-500/10 text-text-accent"
                          : "bg-border-subtle text-text-muted"
                  }`}
                >
                  {tier.badge}
                </span>
                {tier.coming && (
                  <span className="rounded-full bg-eval-warn/10 px-2 py-0.5 text-[10px] font-bold text-eval-warn">
                    Coming Soon
                  </span>
                )}
              </div>

              {/* Name */}
              <h3 className="font-display text-lg font-bold text-text-primary">
                {tier.name}
              </h3>

              {/* Price */}
              <div className="mt-3 flex items-baseline gap-1">
                <span className="font-display text-4xl font-extrabold text-text-primary">
                  {tier.price}
                </span>
                {tier.period && (
                  <span className="text-[14px] text-text-muted">{tier.period}</span>
                )}
              </div>

              {/* Description */}
              <p className="mt-3 text-[13px] leading-relaxed text-text-secondary">
                {tier.description}
              </p>

              {/* CTA */}
              <div className="mt-6">
                <a
                  href={tier.cta.href}
                  className={`block w-full rounded-xl px-4 py-3 text-center text-[14px] font-semibold transition-all ${
                    tier.highlight
                      ? "bg-iris-600 text-white shadow-sm shadow-iris-600/20 hover:bg-iris-500"
                      : "border border-border-default text-text-secondary hover:border-border-glow hover:text-text-primary"
                  }`}
                >
                  {tier.cta.label}
                </a>
              </div>

              {/* Features */}
              <ul className="mt-6 flex-1 space-y-2.5 border-t border-border-subtle pt-6">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-[13px] text-text-secondary">
                    {f.endsWith(":") ? (
                      <span className="font-semibold text-text-primary">{f}</span>
                    ) : (
                      <>
                        <svg className="mt-0.5 h-4 w-4 shrink-0 text-iris-500" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8l3.5 3.5L13 5"/></svg>
                        {f}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </div>

        {/* Bottom note */}
        <p className="mt-10 text-center text-[13px] text-text-muted">
          All plans include unlimited eval rules, both transports (stdio + HTTP), and full API access.
          <br />
          Waitlist members get founding-member pricing and a direct line to shape the roadmap.
        </p>

        {/* Waitlist form */}
        <div className="mx-auto mt-12 max-w-md text-center" id="waitlist">
          <p className="mb-4 text-[14px] font-semibold text-text-primary">
            Get early access to Iris Cloud
          </p>
          {submitted ? (
            <div className="inline-flex items-center gap-2 text-[15px] font-medium text-eval-pass">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
              You&apos;re on the list. We&apos;ll email when it launches.
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit} className="flex gap-3">
                <label htmlFor="pricing-waitlist-email" className="sr-only">Email</label>
                <input
                  id="pricing-waitlist-email"
                  type="email"
                  required
                  disabled={loading}
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="flex-1 rounded-xl border border-border-default bg-bg-base px-5 py-3.5 text-[14px] text-text-primary placeholder:text-text-muted focus:border-iris-500 focus:outline-none focus:ring-2 focus:ring-iris-500/20 disabled:opacity-50"
                />
                <button type="submit" disabled={loading} className="shrink-0 rounded-xl bg-iris-600 px-6 py-3.5 text-[14px] font-semibold text-white shadow-sm shadow-iris-600/20 transition-all hover:bg-iris-500 disabled:opacity-50">
                  {loading ? "Joining..." : "Join Waitlist"}
                </button>
              </form>
              {error && (
                <p className="mt-2 text-[13px] text-eval-fail">{error}</p>
              )}
            </>
          )}
          <p className="mt-3 text-[12px] text-text-muted">
            {waitlistCount && waitlistCount > 0
              ? `${waitlistCount} developer${waitlistCount === 1 ? "" : "s"} on the waitlist. No spam.`
              : "No spam. One email when the cloud tier launches."}
          </p>
        </div>
      </div>
    </section>
  );
}
