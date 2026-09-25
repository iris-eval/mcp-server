import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";
import { checkAdmin } from "../../../lib/admin-auth";

export async function GET(request: Request) {
  const headers = { "X-Content-Type-Options": "nosniff" };

  const admin = checkAdmin(request);
  if (!admin.ok) {
    return NextResponse.json({ error: admin.error }, { status: admin.status, headers });
  }

  const { searchParams } = new URL(request.url);

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
        const parsed = typeof entry === "string" ? JSON.parse(entry) : entry;
        // Rows written before 2026-09-23 carry an ip_hash; it was for rate
        // limiting only and is not exported.
        if (parsed && typeof parsed === "object") delete (parsed as Record<string, unknown>).ip_hash;
        return parsed;
      } catch {
        return { raw: entry };
      }
    });

    const format = searchParams.get("format") || "json";

    if (format === "csv") {
      // A value a spreadsheet would read as a formula (=, +, -, @, tab, CR)
      // is prefixed with an apostrophe, so an "email" like
      // =HYPERLINK(...)@a.co cannot run when the export is opened
      // (2026-09-23 review).
      const escapeCSV = (val: unknown): string => {
        let str = String(val || "");
        if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
        return str.includes(",") || str.includes('"') || str.includes("\n")
          ? `"${str.replace(/"/g, '""')}"` : str;
      };
      const header = "email,timestamp,source,consent\n";
      const rows = entries
        .map(
          (e: Record<string, unknown>) =>
            `${escapeCSV(e.email)},${escapeCSV(e.timestamp)},${escapeCSV(e.source)},${escapeCSV(e.consent)}`
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
