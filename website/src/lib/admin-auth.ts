/**
 * The operator check shared by the site's admin routes (waitlist export and
 * count). A request is an operator's when it carries
 * `Authorization: Bearer <WAITLIST_ADMIN_KEY>`; the comparison takes the same
 * time whatever the input, so a wrong key reveals nothing about the right one.
 */

export type AdminCheck = { ok: true } | { ok: false; status: 401 | 503; error: string };

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function checkAdmin(request: Request, adminKey: string | undefined = process.env.WAITLIST_ADMIN_KEY): AdminCheck {
  if (!adminKey) return { ok: false, status: 503, error: "Admin endpoint not configured" };
  const authHeader = request.headers.get("authorization") || "";
  const providedKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (providedKey.length !== adminKey.length || !timingSafeEqual(providedKey, adminKey)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}
