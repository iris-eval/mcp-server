import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import { ScrollProgress } from "@/components/scroll-progress";
import { Hero } from "@/components/hero";

export const metadata: Metadata = {
  alternates: { canonical: "https://iris-eval.com" },
};
import { Problem } from "@/components/problem";
import { ProductTabs } from "@/components/product-tabs";
import { BuiltFor } from "@/components/customers";
import { Stats } from "@/components/stats";
import { Install } from "@/components/install";
import { Pricing } from "@/components/cloud";
import { FounderQuote } from "@/components/founder-quote";
import { Research } from "@/components/research";
import { Roadmap } from "@/components/roadmap";
import { Footer } from "@/components/footer";

export default function Home(): React.ReactElement {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Iris",
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Any",
            downloadUrl: "https://www.npmjs.com/package/@iris-eval/mcp-server",
            softwareVersion: "0.1.8",
            applicationSubCategory: "AI Agent Evaluation",
            url: "https://iris-eval.com",
            description:
              "The agent eval standard for MCP. Score output quality, catch safety failures, enforce cost budgets across all your agents.",
            offers: {
              "@type": "Offer",
              price: "0",
              priceCurrency: "USD",
            },
          }),
        }}
      />
      <ScrollProgress />
      <Nav />
      <main>
        <Hero />
        <Problem />
        <ProductTabs />
        <BuiltFor />
        <Stats />
        <Install />
        <Pricing />
        <FounderQuote />
        <Research />
        <Roadmap />
      </main>
      <Footer />
    </>
  );
}
