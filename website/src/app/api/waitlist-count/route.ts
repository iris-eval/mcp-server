import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const ALLOWED_ORIGINS = [
    "https://iris-eval.com",
    "https://www.iris-eval.com",
  ];
  if (process.env.VERCEL_ENV !== "production") {
    ALLOWED_ORIGINS.push("http://localhost:8890", "http://localhost:3000");
  }

  const origin = request.headers.get("origin");
  const corsOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : "https://iris-eval.com";

  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": corsOrigin,
    "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
  };

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return NextResponse.json({ count: 0 }, { headers });
  }

  try {
    const redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    const count = await redis.scard("waitlist:emails");
    return NextResponse.json({ count }, { headers });
  } catch (err) {
    console.error("[waitlist-count] error:", (err as Error).message);
    return NextResponse.json({ count: 0 }, { headers });
  }
}
