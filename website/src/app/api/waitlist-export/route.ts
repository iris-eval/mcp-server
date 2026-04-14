import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function GET(request: Request) {
  const headers = { "X-Content-Type-Options": "nosniff" };

  const adminKey = process.env.WAITLIST_ADMIN_KEY;
  if (!adminKey) {
    return NextResponse.json(
      { error: "Admin endpoint not configured" },
      { status: 503, headers }
    );
  }

  const { searchParams } = new URL(request.url);
  const authHeader = request.headers.get("authorization") || "";
  const providedKey = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";
  if (
    providedKey.length !== adminKey.length ||
    !timingSafeEqual(providedKey, adminKey)
  ) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers }
    );
  }

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return NextResponse.json(
      { error: "Redis not configured" },
      { status: 503, headers }
    );
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

    const format = searchParams.get("format") || "json";

    if (format === "csv") {
      const header = "email,timestamp,source,consent\n";
      const rows = entries
        .map(
          (e: Record<string, unknown>) =>
            `${e.email || ""},${e.timestamp || ""},${e.source || ""},${e.consent || ""}`
        )
        .join("\n");
      return new NextResponse(header + rows, {
        status: 200,
        headers: {
          ...headers,
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="iris-waitlist-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    return NextResponse.json(
      {
        count: emails.length,
        emails,
        entries,
        exported_at: new Date().toISOString(),
      },
      { headers }
    );
  } catch (err) {
    console.error("[waitlist-export] error:", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers }
    );
  }
}
