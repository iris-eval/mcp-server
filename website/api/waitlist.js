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

const RATE_LIMIT_MAX = 5; // max submissions per window per IP
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds

// --- Helpers ---
function getCorsOrigin(req) {
  const origin = req.headers.get?.("origin") || req.headers["origin"];
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function hashIP(ip) {
  // Hash IP for rate limiting — never store raw IPs
  const salt = process.env.RATE_LIMIT_SALT || "iris-eval-default-salt";
  return createHash("sha256").update(ip + salt).digest("hex").slice(0, 16);
}

function isValidEmail(email) {
  // RFC 5322 simplified — rejects obvious garbage, not a full validator
  return (
    typeof email === "string" &&
    email.length >= 5 &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  );
}

// --- Handler ---
export default async function handler(req, res) {
  const origin = getCorsOrigin(req);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(204).set(corsHeaders(origin)).end();
  }

  // Set CORS + security headers on all responses
  res.set(corsHeaders(origin));
  res.set("X-Content-Type-Options", "nosniff");

  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Reject if origin not allowed
  if (!origin) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Check Redis is configured
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    // Graceful degradation — accept the submission but can't persist
    console.error("[waitlist] UPSTASH_REDIS not configured");
    return res.status(503).json({ error: "Waitlist temporarily unavailable" });
  }

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  try {
    // Parse body
    const { email } = req.body || {};

    // Validate email
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Rate limiting by hashed IP
    const clientIP =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      "unknown";
    const ipHash = hashIP(clientIP);
    const rateLimitKey = `waitlist:rl:${ipHash}`;

    const currentCount = await redis.get(rateLimitKey);
    if (currentCount && parseInt(currentCount, 10) >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }

    // Check for duplicate (idempotent — submitting same email is a no-op success)
    const exists = await redis.sismember("waitlist:emails", normalizedEmail);
    if (exists) {
      const count = await redis.scard("waitlist:emails");
      return res.status(200).json({ success: true, duplicate: true, count });
    }

    // Store email in a Redis SET (automatic deduplication)
    await redis.sadd("waitlist:emails", normalizedEmail);

    // Store metadata separately (timestamp, source, consent)
    const metadata = {
      email: normalizedEmail,
      timestamp: new Date().toISOString(),
      source: "website",
      consent: true, // user submitted the form = explicit consent
      ip_hash: ipHash, // hashed, not raw — GDPR compliant
    };
    await redis.lpush("waitlist:log", JSON.stringify(metadata));

    // Increment rate limit counter
    const pipeline = redis.pipeline();
    pipeline.incr(rateLimitKey);
    pipeline.expire(rateLimitKey, RATE_LIMIT_WINDOW);
    await pipeline.exec();

    // Return count for social proof (no PII in response)
    const count = await redis.scard("waitlist:emails");

    // Log success without PII
    console.log(`[waitlist] new signup, total: ${count}`);

    return res.status(201).json({ success: true, count });
  } catch (err) {
    console.error("[waitlist] error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
}
