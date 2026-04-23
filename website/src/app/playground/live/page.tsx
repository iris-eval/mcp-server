import type { Metadata } from "next";
import { Nav } from "../../../components/nav";
import { Footer } from "../../../components/footer";
import { LivePlayground } from "../../../components/playground/live-playground";

export const metadata: Metadata = {
  title: "Iris Live Playground — Run real eval rules against your output",
  description:
    "Paste any agent output, pick an eval category, and see the real Iris rule library score it in your browser. 13 rules, instant results, no signup.",
  alternates: { canonical: "https://iris-eval.com/playground/live" },
  openGraph: {
    title: "Iris Live Playground — Run real eval rules against your output",
    description:
      "Paste any agent output and see the real Iris rule library score it instantly.",
    url: "https://iris-eval.com/playground/live",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Iris Live Playground — Run real eval rules against your output",
    description:
      "Paste any agent output and see the real Iris rule library score it instantly.",
    site: "@iris_eval",
  },
};

export default function LivePlaygroundPage() {
  return (
    <>
      <Nav />
      <main>
        <LivePlayground />
      </main>
      <Footer />
    </>
  );
}
