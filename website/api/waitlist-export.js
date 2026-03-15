import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const adminKey = process.env.WAITLIST_ADMIN_KEY;
  if (!adminKey) {
    return res.status(503).json({ error: "Admin endpoint not configured" });
  }

  const providedKey = req.query.key || "";
  if (
    providedKey.length !== adminKey.length ||
    !timingSafeEqual(providedKey, adminKey)
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(503).json({ error: "Redis not configured" });
  }

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  try {
    const emails = await redis.smembers("waitlist:emails");
    const logLength = await redis.llen("waitlist:log");
    const log = await redis.lrange("waitlist:log", 0, logLength - 1);

    const entries = log.map((entry) => {
      try {
        return typeof entry === "string" ? JSON.parse(entry) : entry;
      } catch {
        return { raw: entry };
      }
    });

    const format = req.query.format || "json";

    if (format === "csv") {
      const header = "email,timestamp,source,consent\n";
      const rows = entries
        .map(
          (e) =>
            `${e.email || ""},${e.timestamp || ""},${e.source || ""},${e.consent || ""}`
        )
        .join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="iris-waitlist-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      return res.status(200).send(header + rows);
    }

    return res.status(200).json({
      count: emails.length,
      emails,
      entries,
      exported_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[waitlist-export] error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
