import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";
import { checkAdmin } from "../../../lib/admin-auth";

/**
 * Waitlist size, for the operator only. The number is a business metric, not
 * page copy: it is served behind the same key as the export, and the site
 * does not display it. It doubles as the release checklist's probe that the
 * waitlist store is reachable, so a missing store is reported as 503 rather
 * than read as an empty list.
 */
export async function GET(request: Request) {
  const headers = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };

  const admin = checkAdmin(request);
  if (!admin.ok) {
    return NextResponse.json({ error: admin.error }, { status: admin.status, headers });
  }

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 503, headers });
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
    return NextResponse.json({ error: "Waitlist store unreachable" }, { status: 503, headers });
  }
}
