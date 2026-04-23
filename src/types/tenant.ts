/*
 * tenant — tenant identity primitives.
 *
 * Every storage read/write in Iris takes a TenantId. For OSS / single-
 * user installs the value is always `LOCAL_TENANT` (the literal string
 * `'local'`). For the future Cloud SKU, the value is resolved by the
 * authentication middleware from the session and carried on the
 * request context.
 *
 * Design constraints (from the 2026-04-23 threat model §5.1):
 *   1. Tenant context is a REQUIRED parameter on every storage method;
 *      no Optional<TenantId>. The type system enforces it.
 *   2. The default for OSS is the literal string 'local' — never null,
 *      never undefined, never auto-generated. No "no tenant" code path
 *      exists that could become a "show me everything" path.
 *   3. Tenant resolution happens in middleware, not storage. Storage
 *      receives the resolved TenantId and uses it verbatim.
 *   4. Default-deny: a storage method receiving an empty tenantId MUST
 *      throw TenantContextRequiredError, not return all rows.
 *   5. TenantId is an opaque non-empty string. No assumption beyond
 *      "valid non-empty UTF-8"; Cloud will use UUID/KSUID, OSS uses
 *      'local'.
 *
 * Branded string pattern: we wrap `string` in a nominal brand so passing
 * a raw `string` where `TenantId` is expected is a compile error. The
 * only path to a TenantId is through `asTenantId()` or the LOCAL_TENANT
 * constant — both of which validate non-empty.
 */

/** Nominal brand on string. A plain string cannot be used where TenantId is required. */
export type TenantId = string & { readonly __brand: 'TenantId' };

/** The sentinel tenant used by OSS / single-user installs. */
export const LOCAL_TENANT = 'local' as TenantId;

/**
 * Coerce a raw string into a TenantId after validating non-empty.
 * Throws TenantContextRequiredError when the input is empty/null/undefined.
 *
 * This is the only officially-sanctioned way to mint a TenantId from user
 * input. It centralizes the non-empty invariant so every call site is
 * safe by construction.
 */
export function asTenantId(value: string | null | undefined): TenantId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TenantContextRequiredError(
      `TenantId must be a non-empty string; got ${value === null ? 'null' : typeof value}`,
    );
  }
  return value as TenantId;
}

/**
 * Thrown when a storage method is invoked without a valid tenant
 * context. Fail-safe: we'd rather crash than return data that might
 * cross a tenant boundary.
 *
 * Catch at the route-handler layer and translate to 500 + correlation
 * ID; never surface the raw message to end users.
 */
export class TenantContextRequiredError extends Error {
  constructor(message: string = 'Tenant context required; storage cannot be called without a resolved TenantId') {
    super(message);
    this.name = 'TenantContextRequiredError';
  }
}
