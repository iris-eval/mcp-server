# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Iris, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@iris-eval.com**

You will receive an acknowledgment within 48 hours and a detailed response within 5 business days.

## Scope

This security policy applies to:
- The Iris MCP server (`@iris-eval/mcp-server`)
- The Iris web dashboard
- The Iris website (`iris-eval.com`)

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

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
- Allow us reasonable time to address the issue before public disclosure
- Make a good-faith effort to avoid privacy violations and data destruction
- Do not exploit the vulnerability beyond what is necessary to demonstrate it

## Security Best Practices for Self-Hosting

- Run Iris behind a reverse proxy with TLS
- Restrict dashboard access to trusted networks
- Keep Iris updated to the latest version
- Review eval rule configurations for your specific compliance requirements
