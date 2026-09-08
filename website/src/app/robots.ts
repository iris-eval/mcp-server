import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        // llms.txt is not a robots directive; naming the two files here is
        // a courtesy to crawlers that read robots.txt first, nothing more.
        allow: ["/", "/llms.txt", "/llms-full.txt"],
        disallow: "/api/",
      },
    ],
    sitemap: "https://iris-eval.com/sitemap.xml",
  };
}
