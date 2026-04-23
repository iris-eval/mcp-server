/*
 * tenant — resolves the authenticated tenant from an Express request.
 *
 * This middleware is the SINGLE POINT of tenant resolution. Every
 * downstream code path reads `req.tenantId`; nothing else reads headers
 * or session cookies to figure out which tenant a request belongs to.
 *
 * Current (OSS): always resolves to LOCAL_TENANT. The dashboard is
 * localhost-only; there's no session; there's no multi-tenancy. All
 * data belongs to the single implicit user.
 *
 * Future (Cloud): this file is where the swap happens. The resolver
 * reads the authenticated session (set by an upstream auth middleware),
 * looks up the user's tenant binding, and attaches it to the request.
 * A missing session on a Cloud deployment returns 401.
 *
 * Threat model §5.1 principle #3: "The tenant resolver lives in
 * middleware, not in storage."
 */
import type { RequestHandler, Request } from 'express';
import type { TenantId } from '../types/tenant.js';
import { LOCAL_TENANT } from '../types/tenant.js';

/*
 * Express request type augmentation. Every request that has been
 * through the tenant middleware has a non-optional tenantId.
 */
declare module 'express-serve-static-core' {
  interface Request {
    tenantId?: TenantId;
  }
}

/** Read `req.tenantId` with a fail-safe guarantee for downstream code. */
export function requireTenant(req: Request): TenantId {
  const t = req.tenantId;
  if (!t) {
    /* Defense in depth. Should never happen if tenant middleware is
     * mounted before routes, but we fail safe rather than fall back to
     * LOCAL_TENANT because a missing tenant id is a code path bug, not
     * a fallback case. */
    throw new Error('req.tenantId missing; tenant middleware not mounted?');
  }
  return t;
}

/**
 * OSS tenant resolver. Every request is the single local user.
 *
 * Cloud deployments swap this for an auth-aware resolver that reads the
 * session. The route handlers don't change — they all just call
 * requireTenant(req).
 */
export function createTenantMiddleware(): RequestHandler {
  return (req, _res, next) => {
    req.tenantId = LOCAL_TENANT;
    next();
  };
}
