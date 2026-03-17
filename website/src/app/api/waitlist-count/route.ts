import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";

export async function GET() {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
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
