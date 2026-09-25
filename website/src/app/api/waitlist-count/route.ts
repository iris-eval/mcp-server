import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";
import { waitlistCount } from "../../../lib/waitlist-count";

/**
 * Waitlist size, for the operator only. The number is a business metric, not
 * page copy: it is served behind the same key as the export, and the site
 * does not display it. It doubles as the release checklist's probe that the
 * waitlist store is reachable, so a missing store is reported as 503 rather
 * than read as an empty list.
 */
export async function GET(request: Request) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const answer = await waitlistCount(
    request,
    { adminKey: process.env.WAITLIST_ADMIN_KEY, storeConfigured: Boolean(url && token) },
    () => new Redis({ url: url as string, token: token as string }).scard("waitlist:emails"),
  );
  return NextResponse.json(answer.body, {
    status: answer.status,
    headers: { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
  });
}
