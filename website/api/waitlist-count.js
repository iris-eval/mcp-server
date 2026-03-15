import { Redis } from "@upstash/redis";

// Public endpoint — returns only the waitlist count (no PII)
// Used by the website to display social proof

export default async function handler(req, res) {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Access-Control-Allow-Origin", "*"); // count is public, no PII
  res.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(200).json({ count: 0 });
  }

  try {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    const count = await redis.scard("waitlist:emails");
    return res.status(200).json({ count });
  } catch (err) {
    console.error("[waitlist-count] error:", err.message);
    return res.status(200).json({ count: 0 });
  }
}
