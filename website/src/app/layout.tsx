import type { Metadata } from "next";
import { Space_Grotesk, Manrope, JetBrains_Mono } from "next/font/google";
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
  title: "Iris — The Agent Eval Standard for MCP",
  description:
    "The agent eval standard for MCP. Score output quality, detect PII and injection attacks, enforce cost thresholds across all your agents. Open-source core, self-hosted, one command to start.",
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "Iris — The Agent Eval Standard for MCP",
    description:
      "Score output quality, catch safety failures, enforce cost budgets across every MCP agent. Open-source core.",
    url: "https://iris-eval.com",
    siteName: "Iris",
    type: "website",
    images: ["/og-social-preview.png?v=2"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Iris — The Agent Eval Standard for MCP",
    description:
      "Score your agents. Catch PII leaks, hallucinations, and cost overruns before users do. Open-source MCP server.",
    images: ["/og-social-preview.png?v=2"],
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
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
