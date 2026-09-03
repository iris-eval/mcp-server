import type { Metadata } from "next";
import { Space_Grotesk, Manrope, JetBrains_Mono } from "next/font/google";
import { OG_IMAGE_URL } from "@/lib/og";
import { FEED_TITLE, FEED_URL } from "@/lib/feed";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

const display = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
});

const body = Manrope({
  variable: "--font-body",
  subsets: ["latin"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://iris-eval.com"),
  title: "Iris — stop shipping agents on vibes",
  description:
    "Stop shipping agents on vibes. Score output quality, detect PII and injection attacks, enforce cost thresholds across all your agents. Open-source core, self-hosted, one command to start.",
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "Iris — stop shipping agents on vibes",
    description:
      "Score output quality, catch safety failures, enforce cost budgets across every MCP agent. Open-source core.",
    url: "https://iris-eval.com",
    siteName: "Iris",
    type: "website",
    images: [OG_IMAGE_URL],
  },
  twitter: {
    card: "summary_large_image",
    title: "Iris — stop shipping agents on vibes",
    description:
      "Score your agents. Catch PII leaks, hallucinations, and cost overruns before users do. Open-source MCP server.",
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${display.variable} ${body.variable} ${mono.variable} font-body antialiased`}
      >
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "Iris",
              url: "https://iris-eval.com",
              logo: "https://iris-eval.com/iris-logo.svg",
              sameAs: [
                "https://github.com/iris-eval/mcp-server",
                "https://x.com/iris_eval",
              ],
            }),
          }}
        />
        {/* Feed autodiscovery on every page. This is a rendered <link>, not
            `metadata.alternates.types`, because every page here sets its own
            `alternates` (canonical) and Next resolves a child's alternates
            wholesale instead of merging (next/dist/lib/metadata/resolve-metadata.js,
            case "alternates") — a layout-level types entry would reach no
            page. React hoists a <link> into <head> wherever it renders. */}
        <link rel="alternate" type="application/rss+xml" title={FEED_TITLE} href={FEED_URL} />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
