/*
 * bindPolicy — refuse, don't warn (A6-7).
 *
 * Iris binds loopback by default, and a loopback server needs no key: the
 * machine boundary is the exposure control. A bind beyond loopback is a
 * network deployment, and until 0.13.0 the HTTP transport and the
 * dashboard both WARNED when they got one with no API key, then served —
 * every trace, verdict and rule reachable by anyone who could route to the
 * host. The published Docker image sets IRIS_HOST=0.0.0.0 (a container
 * must; loopback is unreachable through a published port), so a bare
 * `docker run` was exactly that deployment, with the warning scrolling
 * past in a container log nobody reads.
 *
 * One pure function decides, so the CLI pre-flight, the transport and the
 * dashboard cannot disagree: a non-loopback bind with no key is refused
 * unless the operator set `security.allowUnauthenticated`
 * (IRIS_ALLOW_UNAUTHENTICATED=1) — a deliberate, named choice to run open,
 * for a network the operator has already fenced some other way. Loopback
 * without a key keeps its warning. This is the pre-flight pattern of
 * validatePortConfig: a sentence at startup, before any port is bound,
 * rather than a broken state discovered later.
 */
import type { IrisConfig } from '../types/index.js';
import { isLoopbackHost } from '../middleware/rebinding-guard.js';

export const ALLOW_UNAUTHENTICATED_VAR = 'IRIS_ALLOW_UNAUTHENTICATED';

export interface BindPolicyInput {
  surface: 'HTTP transport' | 'dashboard';
  host: string;
  apiKey: string | undefined;
  allowUnauthenticated: boolean;
}

/**
 * The refusal sentence when this bind must not happen, or null when it may.
 * An empty-string key is no key.
 */
export function unauthenticatedBindRefusal(input: BindPolicyInput): string | null {
  if (isLoopbackHost(input.host)) return null;
  if (input.apiKey) return null;
  if (input.allowUnauthenticated) return null;
  return (
    `Refusing to bind the ${input.surface} to ${input.host} without an API key: every trace, verdict and rule ` +
    `on this server would be reachable by anyone who can route to this host. Set IRIS_API_KEY (or --api-key), ` +
    `bind to 127.0.0.1 instead, or set ${ALLOW_UNAUTHENTICATED_VAR}=1 to run open on purpose.`
  );
}

/** Throws when the bind must not happen. */
export function assertAuthenticatedBind(input: BindPolicyInput): void {
  const refusal = unauthenticatedBindRefusal(input);
  if (refusal) throw new Error(refusal);
}

/**
 * The CLI pre-flight: every server this config would bind, checked before
 * any port is taken. The transport counts only when it is HTTP; the
 * dashboard only when it is enabled.
 */
export function validateBindPolicy(config: IrisConfig): void {
  const { apiKey, allowUnauthenticated } = config.security;
  if (config.transport.type === 'http') {
    assertAuthenticatedBind({ surface: 'HTTP transport', host: config.transport.host, apiKey, allowUnauthenticated });
  }
  if (config.dashboard.enabled) {
    assertAuthenticatedBind({ surface: 'dashboard', host: config.dashboard.host, apiKey, allowUnauthenticated });
  }
}
