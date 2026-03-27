import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Terms of Use — Iris",
  description: "Terms and conditions for using Iris and iris-eval.com.",
  alternates: { canonical: "https://iris-eval.com/terms" },
};

export default function Terms(): React.ReactElement {
  return (
    <>
      <Nav />
      <article className="mx-auto max-w-3xl px-6 pb-20 pt-32 lg:pt-40">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-text-primary md:text-4xl">
          Terms of Use
        </h1>
        <p className="mt-2 text-[13px] text-text-muted">Last updated: March 17, 2026</p>

        <div className="mt-10 space-y-8 text-[15px] leading-relaxed text-text-secondary">
          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Agreement</h2>
            <p>
              By accessing iris-eval.com or using the Iris software, you agree to these terms.
              If you do not agree, do not use our website or software.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Open-source software</h2>
            <p>
              The Iris MCP server is open-source software licensed under the{" "}
              <a href="https://github.com/iris-eval/mcp-server/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" className="text-text-accent underline">MIT License</a>.
              The MIT License governs your use of the software, including its warranty disclaimer
              and limitation of liability.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Disclaimer of warranties</h2>
            <p>
              THE SOFTWARE AND WEBSITE ARE PROVIDED &ldquo;AS IS&rdquo; WITHOUT WARRANTY OF ANY KIND,
              EXPRESS OR IMPLIED. THIS INCLUDES, WITHOUT LIMITATION, WARRANTIES OF
              MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
            </p>
            <p className="mt-3">Specifically:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong>Evaluation rules are heuristic, not guaranteed.</strong> Iris&apos;s PII detection,
                prompt injection detection, and hallucination markers use pattern-based heuristics.
                They are not a substitute for comprehensive security audits, manual review, or
                regulatory compliance programs. False positives and false negatives are possible.
              </li>
              <li>
                <strong>Cost estimates are approximate.</strong> Token-based cost calculations depend
                on model pricing that may change without notice. Iris does not guarantee cost
                accuracy and should not be the sole basis for financial decisions.
              </li>
              <li>
                <strong>Comparison pages reflect a point in time.</strong> Our competitor comparison
                pages are based on publicly available documentation as of the date shown. Competitors
                may update their products at any time. We aim to keep comparisons current but do not
                guarantee accuracy.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Limitation of liability</h2>
            <p>
              IN NO EVENT SHALL IRIS, ITS CONTRIBUTORS, OR AFFILIATES BE LIABLE FOR ANY
              INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING OUT
              OF OR RELATED TO YOUR USE OF THE SOFTWARE OR WEBSITE, INCLUDING BUT NOT LIMITED
              TO DAMAGES FOR LOSS OF DATA, REVENUE, PROFITS, OR BUSINESS OPPORTUNITIES,
              REGARDLESS OF WHETHER SUCH DAMAGES WERE FORESEEABLE.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Compliance and regulatory use</h2>
            <p>
              Iris may assist with traceability and audit trails that support regulatory frameworks
              such as the EU AI Act. However, use of Iris does not constitute compliance with any
              regulation. You are solely responsible for ensuring your AI systems meet applicable
              legal and regulatory requirements.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Acceptable use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>Use the website or API to transmit malicious content or conduct attacks</li>
              <li>Attempt to circumvent rate limiting or security measures</li>
              <li>Misrepresent your affiliation with Iris</li>
              <li>Use the Iris name or logo without permission (the software itself is MIT licensed)</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Cloud tier (future)</h2>
            <p>
              When the Iris cloud tier launches, additional terms will apply to paid services
              including service level agreements, data processing agreements, and billing terms.
              These will be published separately and will not retroactively change the terms for
              the open-source software.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Changes to these terms</h2>
            <p>
              We may update these terms from time to time. Changes will be posted on this page
              with an updated &ldquo;Last updated&rdquo; date. Continued use constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold text-text-primary">Contact</h2>
            <p>
              Questions about these terms? Email{" "}
              <a href="mailto:hello@iris-eval.com" className="text-text-accent underline">hello@iris-eval.com</a>.
            </p>
          </section>
        </div>
      </article>
      <Footer />
    </>
  );
}
