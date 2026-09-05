# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Iris, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email **security@iris-eval.com** or submit through GitHub's **Private Vulnerability Reporting** at https://github.com/iris-eval/mcp-server/security/advisories/new — this delivers the report privately to maintainers, supports attachments, and avoids email entirely. A PGP public key for the email channel is available on request to the same address.

We aim to acknowledge receipt within 48 hours and provide a detailed response within 5 business days. These are best-effort targets — Iris is currently maintained by a solo founder, so a brief delay during travel or focused-work periods is possible. Critical vulnerabilities (active exploitation, RCE, data exposure) get top priority regardless.

## Scope

This security policy applies to:
- The Iris MCP server (`@iris-eval/mcp-server`)
- The Iris web dashboard
- The Iris website (`iris-eval.com`)

## Open Advisory Posture

For every open Dependabot advisory on this repo, [`SECURITY-EXPOSURE.md`](./SECURITY-EXPOSURE.md) records the per-surface threat-model assessment: load-graph reachability, code-path reachability, untrusted-input reachability, downstream guards, and the resulting decision (override / dismiss-as-not-used / dismiss-as-tolerable-risk / track / patch). CI fails any PR that surfaces a new ≥medium advisory without a corresponding row in that file. This is the substance behind any "open alerts" count you see on the GitHub Security tab.

## Review Posture

Iris has one maintainer. Every change reaches `main` through a pull request that must pass the required CI checks listed in [CONTRIBUTING.md](./CONTRIBUTING.md) — lint and typecheck, unit and integration tests on two Node versions, end-to-end, build, the Docker image started as shipped, the security-exposure gate, the hardcoded-claim scanner and the truthbase regeneration — and CodeQL runs on every pull request; the maintainer reviews and squash-merges it. There is no second human reviewer today, and this policy says so rather than implying one. If that is not enough for your threat model, pin a version and verify the signed release assets (SBOMs, Sigstore bundles, the image signature) the way each release's notes describe; the release workflow runs that verification itself before it reports success.

## Supported Versions

Only the latest minor receives security fixes. Older minors do not — upgrade to the current `0.9.x` line.

| Version          | Supported |
|------------------|-----------|
| 0.9.x            | Yes       |
| 0.8.x and lower  | No        |

<!--
  This table is release-gated: it must name the CURRENT minor, which is
  `release.currentReleaseVersion` in .claims.json. On v0.5.0's ship day it
  still read "upgrade to the current 0.4.x line", i.e. by the policy's own
  rule it advertised an unsupported line as the supported one. Update it in
  the release PR, alongside CHANGELOG.md and the version sync.
-->

Verify what you are running: `npx @iris-eval/mcp-server --version`, or read the first startup log line.

## What We Consider a Vulnerability

- Remote code execution
- PII/data exposure in eval outputs
- Injection attacks through MCP tool inputs
- Authentication or authorization bypasses in the dashboard
- Denial of service affecting the MCP server
- Supply chain vulnerabilities in dependencies

## What We Do NOT Consider a Vulnerability

- Self-hosted deployment misconfigurations
- Rate limiting on self-hosted instances (user responsibility)
- Vulnerabilities in third-party MCP clients

## Disclosure Policy

We follow coordinated disclosure. We will:
1. Acknowledge receipt within 48 hours
2. Confirm the vulnerability and determine its impact
3. Develop and test a fix
4. Release the fix and publish an advisory
5. Credit the reporter (unless they prefer anonymity)

We ask that you:
- Allow us 90 days by default before public disclosure — negotiable for high-severity or actively exploited issues, where a shorter window is in everyone's interest
- Make a good-faith effort to avoid privacy violations and data destruction
- Do not exploit the vulnerability beyond what is necessary to demonstrate it

## Security Best Practices for Self-Hosting

- Run Iris behind a reverse proxy with TLS
- Restrict dashboard access to trusted networks
- Keep Iris updated to the latest version
- Review eval rule configurations for your specific compliance requirements
