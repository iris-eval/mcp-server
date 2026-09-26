/*
 * The release workflow agrees with itself, and the judge workflow fails when
 * it cannot run.
 *
 * An audit on 2026-09-05 found the evaluator-of-evaluators runtime weaker
 * than its docs: the release notes told readers to `cosign verify-blob` the
 * SBOM bundles while no job ever ran that command; the bundles carried a
 * suffix OpenSSF Scorecard's Signed-Releases check does not recognise, so
 * every signed release scored 0 there; and proof-judge.yml went green when
 * no key was configured, a green that meant nothing.
 *
 * These assertions read the workflow files as text. They are not a YAML
 * parser; they pin the four places a bundle name appears (sign, notes,
 * upload, verify) to one suffix and the presence of the verification step,
 * so a rename in one place fails here instead of on the next release.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
// LF-normalised: a Windows checkout may carry CRLF, and the assertions match on LF.
const workflow = (rel: string): string => readFileSync(resolve(root, rel), 'utf8').replace(/\r\n/g, '\n');
const release = workflow('.github/workflows/release.yml');
const judge = workflow('.github/workflows/proof-judge.yml');
const nightly = workflow('.github/workflows/nightly-real-llm-smoke.yml');

/** The suffix Scorecard's Signed-Releases check recognises for a Sigstore bundle. */
const BUNDLE_SUFFIX = '.sigstore.json';
/** The suffix the releases carried before 0.8.2, which Scorecard ignored. */
const RETIRED_SUFFIX = ['.cosign', '.bundle'].join('');
const SBOMS = ['iris-npm-sbom.spdx.json', 'iris-docker-sbom.spdx.json'];
/** The MCPB bundle (#650): attached, signed and verified the way the SBOMs are. */
const MCPB = 'iris-eval.mcpb';
/** Every release asset that has a Sigstore bundle beside it. */
const SIGNED = [...SBOMS, MCPB];

describe('release.yml — the SBOM signature bundles', () => {
  it('carries no trace of the unrecognised suffix', () => {
    expect(release).not.toContain(RETIRED_SUFFIX);
  });

  it('signs each SBOM into a bundle with the recognised suffix', () => {
    expect(release).toContain(`--bundle "\${sbom}${BUNDLE_SUFFIX}"`);
  });

  it('uploads both SBOMs, the MCPB bundle, and a signature bundle for each as release assets', () => {
    const files = release.match(/files: \|\n([\s\S]*?)\n\s+body_path:/);
    expect(files, 'the action-gh-release files block').not.toBeNull();
    const names = files![1].split('\n').map((l) => l.trim().replace(/^\.\/release-assets\//, '')).filter(Boolean);
    expect(names.sort()).toEqual(SIGNED.flatMap((s) => [s, `${s}${BUNDLE_SUFFIX}`]).sort());
  });

  it('verify-release checks the same six assets are attached', () => {
    const loop = release.match(/for a in ([^;]+); do\n\s+jq -e --arg a "\$a" '\.assets\[\]/);
    expect(loop, 'the asset-presence loop').not.toBeNull();
    const names = loop![1].replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
    expect(names.sort()).toEqual(SIGNED.flatMap((s) => [s, `${s}${BUNDLE_SUFFIX}`]).sort());
  });

  it('the release notes tell readers to verify with the same bundle name', () => {
    expect(release).toContain(`--bundle iris-npm-sbom.spdx.json${BUNDLE_SUFFIX}`);
  });

  it('verify-release runs cosign verify-blob on the bundles, not only a presence check', () => {
    const verifyJob = release.slice(release.indexOf('\n  verify-release:'));
    expect(verifyJob).toContain('cosign verify-blob');
    expect(verifyJob).toContain(`--bundle "\${sbom}${BUNDLE_SUFFIX}"`);
    expect(verifyJob).toContain('--certificate-oidc-issuer');
    expect(verifyJob).toMatch(/cosign-installer@[0-9a-f]{40}/);
  });
});

describe('the keyed measurement workflows fail loudly without a key', () => {
  const absentBranch = (text: string): string => {
    const start = text.indexOf('echo "present=false"');
    expect(start, 'the present=false branch').toBeGreaterThan(-1);
    const end = text.slice(start).search(/\n\s*fi\b/);
    expect(end, 'the closing fi').toBeGreaterThan(-1);
    return text.slice(start, start + end);
  };

  it('proof-judge.yml errors and exits 1 when the provider key is unset (it used to skip and go green)', () => {
    const branch = absentBranch(judge);
    expect(branch).toContain('::error::');
    expect(branch).toContain('exit 1');
    expect(branch).not.toContain('::notice::');
  });

  it('nightly-real-llm-smoke.yml does the same', () => {
    const branch = absentBranch(nightly);
    expect(branch).toContain('::error::');
    expect(branch).toContain('exit 1');
  });
});

describe('the image — labels, HEALTHCHECK, and the CI run that checks them', () => {
  const dockerfile = workflow('Dockerfile');
  const ci = workflow('.github/workflows/ci.yml');

  it('the Dockerfile carries the static OCI labels', () => {
    expect(dockerfile).toContain('org.opencontainers.image.source="https://github.com/iris-eval/mcp-server"');
    expect(dockerfile).toContain('org.opencontainers.image.licenses="MIT"');
    expect(dockerfile).toMatch(/org\.opencontainers\.image\.description="Stop shipping agents on vibes\./);
    expect(dockerfile).toContain('org.opencontainers.image.url="https://iris-eval.com"');
  });

  it('the release build stamps version, revision and created from the tag and the commit', () => {
    expect(release).toContain('org.opencontainers.image.version=${{ steps.docker-tags.outputs.version }}');
    expect(release).toContain('org.opencontainers.image.revision=${{ github.sha }}');
    expect(release).toContain('org.opencontainers.image.created=${{ steps.docker-tags.outputs.created }}');
    expect(release).toContain('echo "version=${GITHUB_REF_NAME#v}"');
  });

  it('the Dockerfile has a HEALTHCHECK on the transport /health that reads IRIS_PORT', () => {
    expect(dockerfile).toMatch(/^HEALTHCHECK --interval=\d+s --timeout=\d+s --start-period=\d+s --retries=\d+ /m);
    expect(dockerfile).toContain("(process.env.IRIS_PORT || 3000) + '/health'");
  });

  it('CI runs the shipped image and requires healthy, the checks block on both ports, and the labels', () => {
    expect(ci).toContain("{{.State.Health.Status}}");
    expect(ci).toContain('"http://127.0.0.1:3000/health" "http://127.0.0.1:6920/api/v1/health"');
    expect(ci).toContain(`grep -q '"migrations":{"status":"ok"'`);
    expect(ci).toContain('org.opencontainers.image.source org.opencontainers.image.description org.opencontainers.image.licenses');
  });
});

/*
 * 2026-09-23 security review. The job that held the npm
 * publishing identity also ran every dependency's code; a tag at any commit,
 * or a dispatch on any branch, could publish; and the documented signature
 * check accepted a signature from any workflow on any branch of the repo.
 */
function job(name: string): string {
  const start = release.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job ${name} in release.yml`);
  const next = release.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? release.slice(start) : release.slice(start, start + 1 + next);
}

describe('release.yml — who can publish, and from what', () => {
  it('the build runs without the publishing identity', () => {
    const build = job('build-npm');
    expect(build).not.toContain('id-token');
    expect(build).toContain('npm ci');
    expect(build).toContain('npm pack');
  });

  it('the job with the publishing identity installs and builds nothing: it publishes the packed tarball with scripts off', () => {
    // Steps only: the job's comments explain what it does not run, in those words.
    const publish = job('publish-npm')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(publish).toContain('id-token: write');
    expect(publish).toContain('needs: build-npm');
    expect(publish).not.toMatch(/npm (ci|install|run)\b/);
    expect(publish).not.toContain('actions/checkout');
    expect(publish).toMatch(/npm publish "\.\/\$TARBALL" [^\n]*--ignore-scripts/);
  });

  it('releases only a v* tag whose commit is on main', () => {
    const validate = job('validate');
    expect(validate).toContain("if: ${{ startsWith(github.ref, 'refs/tags/v') }}");
    expect(validate).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
  });

  it('every signature check names the release workflow as the signer, not just the repository', () => {
    expect(release).not.toContain('--certificate-identity-regexp');
    expect(release).toContain('.github/workflows/release.yml@refs/tags/__TAG__');
    expect(release).toContain('.github/workflows/release.yml@${GITHUB_REF}');
  });
});

/*
 * The MCPB bundle (#650). It is built from the tarball npm receives, by a
 * job with no identity; signed, attested and attached by github-release;
 * named in server.json with the hash of the attached file, which only
 * exists once github-release has run; and read back from outside by
 * verify-release. None of it touches the npm publish.
 */
describe('release.yml — the MCPB bundle', () => {
  const steps = (name: string): string =>
    job(name)
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

  it('is built without an identity, from the tarball build-npm packed, twice, and checked against it', () => {
    const build = steps('build-mcpb');
    expect(build).toContain('needs: build-npm');
    expect(build).not.toContain('id-token');
    expect(build).toContain('TARBALL: ${{ needs.build-npm.outputs.tarball }}');
    expect(build).toContain('node scripts/mcpb/pack.mjs --tarball "$TARBALL" --out iris-eval.mcpb');
    expect(build).toMatch(/cmp iris-eval\.mcpb "\$RUNNER_TEMP\/second\.mcpb"/);
    expect(build).toContain('node scripts/mcpb/verify.mjs --bundle iris-eval.mcpb --tarball "$TARBALL"');
    expect(build).toContain('sha256=$(sha256sum iris-eval.mcpb');
  });

  it('is unpacked and validated by the pinned reference tooling, and started by tests/mcpb, before it is handed on', () => {
    const build = steps('build-mcpb');
    expect(build).toContain('npm install --no-audit --no-fund @anthropic-ai/mcpb@2.1.2');
    expect(build).toMatch(/"\$mcpb" unpack iris-eval\.mcpb/);
    expect(build).toMatch(/"\$mcpb" validate "\$RUNNER_TEMP\/unpacked\/manifest\.json"/);
    expect(build).toContain('npx vitest run --config tests/mcpb/vitest.config.ts');
    expect(build.indexOf('tests/mcpb/vitest.config.ts')).toBeLessThan(build.indexOf('name: mcpb-bundle'));
  });

  it('leaves the npm publish alone', () => {
    expect(steps('publish-npm')).not.toMatch(/mcpb/i);
    expect(steps('build-npm')).not.toMatch(/mcpb/i);
  });

  it('github-release checks it is the file build-mcpb built, then signs it with the recognised suffix and attests it', () => {
    const gh = steps('github-release');
    expect(gh).toMatch(/needs: \[[^\]]*build-mcpb[^\]]*\]/);
    expect(gh).toContain('attestations: write');
    expect(gh).toContain('WANT: ${{ needs.build-mcpb.outputs.sha256 }}');
    expect(gh).toContain(`--bundle "${MCPB}${BUNDLE_SUFFIX}"`);
    expect(gh).toMatch(/actions\/attest-build-provenance@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+subject-path: release-assets\/iris-eval\.mcpb/);
    expect(gh.indexOf('needs.build-mcpb.outputs.sha256')).toBeLessThan(gh.indexOf(`--bundle "${MCPB}${BUNDLE_SUFFIX}"`));
  });

  it('the release notes tell readers how to verify it, under the release workflow\'s identity', () => {
    expect(release).toContain(`--bundle ${MCPB}${BUNDLE_SUFFIX}`);
    expect(release).toContain(`gh attestation verify ${MCPB} -R __REPO__`);
  });

  it('publish-registry runs after the bundle is attached and stamps the attached file\'s hash before it publishes', () => {
    const registry = steps('publish-registry');
    expect(registry).toMatch(/needs: \[[^\]]*github-release[^\]]*\]/);
    expect(registry).toContain('gh release download "$GITHUB_REF_NAME" -R "$GITHUB_REPOSITORY" -p iris-eval.mcpb');
    expect(registry).toContain('WANT: ${{ needs.build-mcpb.outputs.sha256 }}');
    expect(registry).toContain('.fileSha256 = $h');
    const stamp = registry.indexOf('.fileSha256 = $h');
    expect(stamp).toBeLessThan(registry.indexOf('./mcp-publisher validate server.json'));
    expect(stamp).toBeLessThan(registry.indexOf('./mcp-publisher publish server.json'));
  });

  it('verify-release checks its signature, its attestation, that it holds the package npm serves, and the registry\'s hash', () => {
    const verify = steps('verify-release');
    expect(verify).toContain('attestations: read');
    expect(verify).toMatch(/cosign verify-blob \\\n\s+--bundle iris-eval\.mcpb\.sigstore\.json \\\n\s+--certificate-identity="https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/release\.yml@\$\{GITHUB_REF\}"/);
    expect(verify).toContain('gh attestation verify iris-eval.mcpb -R "$GITHUB_REPOSITORY"');
    expect(verify).toContain('https://registry.npmjs.org/@iris-eval%2Fmcp-server/${VERSION}');
    expect(verify).toContain('node ../scripts/mcpb/verify.mjs --bundle iris-eval.mcpb --tarball package.tgz');
    expect(verify).toContain('select(.registryType == "mcpb") | .fileSha256');
  });
});
