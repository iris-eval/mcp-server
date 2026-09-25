import { checkAdmin } from "./admin-auth";

/**
 * The waitlist-size answer, independent of the store client so it can be
 * tested without one: the route passes a function that counts the set.
 * Operator only (same key as the export); a missing or failing store is 503,
 * never read as an empty list.
 */
export type WaitlistCountAnswer = { status: number; body: { count: number } | { error: string } };

export async function waitlistCount(
  request: Request,
  env: { adminKey?: string; storeConfigured: boolean },
  countMembers: () => Promise<number>,
): Promise<WaitlistCountAnswer> {
  const admin = checkAdmin(request, env.adminKey);
  if (!admin.ok) return { status: admin.status, body: { error: admin.error } };
  if (!env.storeConfigured) return { status: 503, body: { error: "Redis not configured" } };
  try {
    return { status: 200, body: { count: await countMembers() } };
  } catch (err) {
    console.error("[waitlist-count] error:", (err as Error).message);
    return { status: 503, body: { error: "Waitlist store unreachable" } };
  }
}
