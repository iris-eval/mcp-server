import { Redis } from "@upstash/redis";
import { createHash } from "crypto";
import { NextResponse } from "next/server";

const ALLOWED_ORIGINS = [
  "https://iris-eval.com",
  "https://www.iris-eval.com",
];
if (process.env.VERCEL_ENV !== "production") {
  ALLOWED_ORIGINS.push("http://localhost:8890", "http://localhost:3000");
}

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 3600;

function getCorsOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  return origin && ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin || "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
  };
}

function hashIP(ip: string): string {
  const salt = process.env.RATE_LIMIT_SALT;
  if (!salt) {
    throw new Error("RATE_LIMIT_SALT environment variable is required for /api/waitlist");
  }
  return createHash("sha256").update(ip + salt).digest("hex").slice(0, 16);
}

function isValidEmail(email: unknown): email is string {
  return (
    typeof email === "string" &&
    email.length >= 5 &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  );
}

export async function OPTIONS(request: Request) {
  const origin = getCorsOrigin(request);
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: Request) {
  const origin = getCorsOrigin(request);
  const headers = corsHeaders(origin);

  if (!origin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  }

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("[waitlist] UPSTASH_REDIS not configured");
    return NextResponse.json(
      { error: "Waitlist temporarily unavailable" },
      { status: 503, headers }
    );
  }

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  try {
    const body = await request.json();
    const { email } = body || {};

    if (!isValidEmail(email)) {
      return NextResponse.json(
        { error: "Invalid email address" },
        { status: 400, headers }
      );
    }

    const normalizedEmail = email.trim().toLowerCase();

    const clientIP =
      (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    const ipHash = hashIP(clientIP);
    const rateLimitKey = `waitlist:rl:${ipHash}`;

    const currentCount = await redis.get<number>(rateLimitKey);
    if (currentCount && currentCount >= RATE_LIMIT_MAX) {
      return NextResponse.json(
        { error: "Too many requests. Try again later." },
        { status: 429, headers }
      );
    }

    const exists = await redis.sismember("waitlist:emails", normalizedEmail);
    if (exists) {
      const count = await redis.scard("waitlist:emails");
      return NextResponse.json(
        { success: true, duplicate: true, count },
        { status: 200, headers }
      );
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

    return NextResponse.json(
      { success: true, count },
      { status: 201, headers }
    );
  } catch (err) {
    console.error("[waitlist] error:", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers }
    );
  }
}
