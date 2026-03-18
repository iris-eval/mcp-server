# Release Checklist

Run through this before every version release. No exceptions.

## Pre-release

- [ ] Bump version in `package.json`
- [ ] Run `npm run version:sync` (auto-updates server.json, .well-known/mcp.json)
- [ ] Run `npm run version:check` (validates all versions match)
- [ ] Run `bash scripts/check-product-claims.sh` (validates website stats match source)
- [ ] Update `CHANGELOG.md` with new version entry
- [ ] Run `npm test` — all tests pass
- [ ] Run `npm run lint` — no lint errors
- [ ] Run `npm run typecheck` — no type errors

## Release

- [ ] Commit version bump + changelog
- [ ] Create git tag: `git tag v0.x.x`
- [ ] Push tag: `git push origin v0.x.x`
- [ ] Verify GitHub Actions: npm publish succeeded
- [ ] Verify GitHub Actions: Docker image pushed
- [ ] Verify GitHub Release created with changelog

## Post-release

- [ ] Run `mcp-publisher publish` (update Official MCP Registry)
- [ ] Verify npm page shows new version: npmjs.com/package/@iris-eval/mcp-server
- [ ] Verify iris-eval.com/.well-known/mcp.json shows new version
- [ ] Check shields.io badges on README show new version
- [ ] Post release announcement on X (@iris_eval)

## Quarterly reviews (add to calendar)

- [ ] Review all 5 comparison pages for accuracy (competitors may have shipped new features)
- [ ] Check Porkbun domain auto-renew is enabled for iris-eval.com
- [ ] Verify npm token in GitHub Secrets hasn't expired
- [ ] Verify Upstash Redis credentials still work (check /api/waitlist-count)
- [ ] Review pricing across all files if any pricing changes planned
- [ ] Search for new MCP directories and awesome lists to submit to
