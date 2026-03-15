import { Redis } from "@upstash/redis";
import { createHash } from "crypto";

// --- Configuration ---
const ALLOWED_ORIGINS = [
  "https://iris-eval.com",
  "https://www.iris-eval.com",
];
if (process.env.VERCEL_ENV !== "production") {
  ALLOWED_ORIGINS.push("http://localhost:8890", "http://localhost:3000");
}

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 3600;

function getCorsOrigin(req) {
  const origin = req.headers["origin"];
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin || "");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function hashIP(ip) {
  const salt = process.env.RATE_LIMIT_SALT || "iris-eval-default-salt";
  return createHash("sha256").update(ip + salt).digest("hex").slice(0, 16);
}

function isValidEmail(email) {
  return (
    typeof email === "string" &&
    email.length >= 5 &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  );
}

export default async function handler(req, res) {
  const origin = getCorsOrigin(req);
  setCors(res, origin);
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!origin) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.error("[waitlist] UPSTASH_REDIS not configured");
    return res.status(503).json({ error: "Waitlist temporarily unavailable" });
  }

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  try {
    const { email } = req.body || {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const clientIP =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.headers["x-real-ip"] ||
      "unknown";
    const ipHash = hashIP(clientIP);
    const rateLimitKey = `waitlist:rl:${ipHash}`;

    const currentCount = await redis.get(rateLimitKey);
    if (currentCount && parseInt(currentCount, 10) >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }

    const exists = await redis.sismember("waitlist:emails", normalizedEmail);
    if (exists) {
      const count = await redis.scard("waitlist:emails");
      return res.status(200).json({ success: true, duplicate: true, count });
    }

    await redis.sadd("waitlist:emails", normalizedEmail);

    const metadata = {
      email: normalizedEmail,
      timestamp: new Date().toISOString(),
      source: "website",
      consent: true,
      ip_hash: ipHash,
    };
    await redis.lpush("waitlist:log", JSON.stringify(metadata));

    const pipeline = redis.pipeline();
    pipeline.incr(rateLimitKey);
    pipeline.expire(rateLimitKey, RATE_LIMIT_WINDOW);
    await pipeline.exec();

    const count = await redis.scard("waitlist:emails");
    console.log(`[waitlist] new signup, total: ${count}`);

    return res.status(201).json({ success: true, count });
  } catch (err) {
    console.error("[waitlist] error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
}
