import type { Metadata } from "next";
import { Nav } from "../../components/nav";
import { Footer } from "../../components/footer";
import { PlaygroundLoader } from "../../components/playground/playground-loader";

export const metadata: Metadata = {
  title: "Iris Playground — Try Agent Eval in 60 Seconds",
  description:
    "Interactive demo: spot PII leaks in agent output, compare agent quality scores, explore the eval dashboard. No install, no signup.",
  openGraph: {
    title: "Iris Playground — Try Agent Eval in 60 Seconds",
    description:
      "Interactive demo: spot PII leaks in agent output, compare agent quality scores, explore the eval dashboard.",
    url: "https://iris-eval.com/playground",
    type: "website",
    images: ["/og-social-preview.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Iris Playground — Try Agent Eval in 60 Seconds",
    description:
      "Spot PII leaks. Compare agent scores. Explore the eval dashboard. No install.",
    images: ["/og-social-preview.png"],
    site: "@iris_eval",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Iris Playground",
  description:
    "Interactive demo: spot PII leaks in agent output, compare agent quality scores, explore the eval dashboard.",
  url: "https://iris-eval.com/playground",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Any",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default function PlaygroundPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Nav />
      <main>
        <PlaygroundLoader />
      </main>
      <Footer />
    </>
  );
}
