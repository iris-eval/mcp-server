import { Nav } from "@/components/nav";
import { ScrollProgress } from "@/components/scroll-progress";
import { Hero } from "@/components/hero";
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
