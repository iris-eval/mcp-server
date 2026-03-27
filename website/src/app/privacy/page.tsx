import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Privacy Policy — Iris",
  description: "How Iris collects, uses, and protects your data.",
  alternates: { canonical: "https://iris-eval.com/privacy" },
};

export default function Privacy(): React.ReactElement {
  return (
    <>
      <Nav />
      <article className="mx-auto max-w-3xl px-6 pb-20 pt-32 lg:pt-40">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-text-primary md:text-4xl">
          Privacy Policy
        </h1>
        <p className="mt-2 text-[13px] text-text-muted">Last updated: March 17, 2026</p>

        <div className="mt-10 space-y-8 text-[15px] leading-relaxed text-text-secondary">
          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Overview</h2>
            <p>
              Iris (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) is an open-source MCP server for AI agent
              evaluation and observability. This privacy policy explains how we handle data across
              our website (iris-eval.com) and the Iris software.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">What we collect</h2>
            <h3 className="mb-2 text-[16px] font-semibold text-text-primary">Website (iris-eval.com)</h3>
            <ul className="list-disc space-y-2 pl-6">
              <li><strong>Waitlist email address:</strong> If you join the cloud tier waitlist, we store your email address. This is the only personal data we collect.</li>
              <li><strong>Hashed IP address:</strong> For rate limiting only. We store a one-way SHA-256 hash of your IP — we cannot reverse this to identify you.</li>
              <li><strong>Analytics:</strong> We use Vercel Web Analytics, which collects anonymous page view data. No cookies, no personal data, no cross-site tracking.</li>
            </ul>
            <h3 className="mb-2 mt-4 text-[16px] font-semibold text-text-primary">Self-hosted Iris software</h3>
            <ul className="list-disc space-y-2 pl-6">
              <li><strong>All data stays on your machine.</strong> The self-hosted version stores traces, evaluations, and metrics in a local SQLite database. No data is sent to us or any third party.</li>
              <li>We do not collect telemetry, usage data, or analytics from the self-hosted software.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">How we use your data</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li><strong>Waitlist emails:</strong> Solely to notify you when the cloud tier launches. We do not sell, share, or use your email for any other purpose.</li>
              <li><strong>IP hashes:</strong> Solely for rate limiting to prevent abuse. Automatically expire after 1 hour.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Data storage and security</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>Waitlist data is stored in Upstash Redis (encrypted at rest, served over TLS).</li>
              <li>We use CORS restrictions, rate limiting, and input validation to protect the waitlist API.</li>
              <li>We do not store passwords, payment information, or sensitive credentials.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Your rights</h2>
            <p>You have the right to:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li><strong>Access:</strong> Request a copy of any data we hold about you.</li>
              <li><strong>Deletion:</strong> Request deletion of your waitlist email at any time.</li>
              <li><strong>Correction:</strong> Request correction of inaccurate data.</li>
              <li><strong>Portability:</strong> Request your data in a machine-readable format.</li>
            </ul>
            <p className="mt-3">
              To exercise any of these rights, email{" "}
              <a href="mailto:hello@iris-eval.com" className="text-text-accent underline">hello@iris-eval.com</a>.
              We will respond within 30 days.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Third-party services</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li><strong>Vercel:</strong> Website hosting and serverless functions. <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-text-accent underline">Vercel Privacy Policy</a></li>
              <li><strong>Upstash:</strong> Redis database for waitlist storage. <a href="https://upstash.com/trust/privacy.pdf" target="_blank" rel="noopener noreferrer" className="text-text-accent underline">Upstash Privacy Policy</a></li>
              <li><strong>GitHub:</strong> Source code hosting. <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener noreferrer" className="text-text-accent underline">GitHub Privacy Statement</a></li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Cookies</h2>
            <p>
              We do not use cookies. Vercel Web Analytics is cookie-free.
              No tracking pixels, no fingerprinting, no cross-site tracking.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Changes to this policy</h2>
            <p>
              We may update this policy from time to time. Changes will be posted on this page
              with an updated &ldquo;Last updated&rdquo; date. Continued use of the website after changes
              constitutes acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Contact</h2>
            <p>
              Questions about this privacy policy? Email{" "}
              <a href="mailto:hello@iris-eval.com" className="text-text-accent underline">hello@iris-eval.com</a>.
            </p>
          </section>
        </div>
      </article>
      <Footer />
    </>
  );
}
