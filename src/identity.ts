/*
 * The one machine-read identifier.
 *
 * Until 0.13.0 the product answered to five names depending on the door:
 * the repo's own .mcp.json said "iris", the plugin manifest "iris", the
 * marketplace "iris-eval", the command "iris-mcp", the compose service and
 * the OTel default "iris-mcp". An agent that copied one door could not
 * match the docs of another, and a search for the bare word lands on three
 * other projects. Every config key, plugin name, skill name, service name
 * and command derives from or is asserted equal to PUBLIC_ID
 * (tests/identity.test.ts). "Iris" stays the product's name in prose.
 */
export const PUBLIC_ID = 'iris-eval';
export const PRODUCT_NAME = 'Iris';
/** The command name every surface documents. */
export const COMMAND = 'iris-eval';
/** The original command name. Still installed so every existing config keeps running; no surface documents it. */
export const LEGACY_COMMAND = 'iris-mcp';
