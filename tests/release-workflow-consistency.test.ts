/*
 * The release workflow agrees with itself, and the judge workflow fails when
 * it cannot run.
 *
 * Arc zero (2026-09-05, G17) found the evaluator-of-evaluators runtime weaker
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

describe('release.yml — the SBOM signature bundles', () => {
  it('carries no trace of the unrecognised suffix', () => {
    expect(release).not.toContain(RETIRED_SUFFIX);
  });

  it('signs each SBOM into a bundle with the recognised suffix', () => {
    expect(release).toContain(`--bundle "\${sbom}${BUNDLE_SUFFIX}"`);
  });

  it('uploads both SBOMs and both bundles as release assets', () => {
    const files = release.match(/files: \|\n([\s\S]*?)\n\s+body_path:/);
    expect(files, 'the action-gh-release files block').not.toBeNull();
    const names = files![1].split('\n').map((l) => l.trim().replace(/^\.\/release-assets\//, '')).filter(Boolean);
    expect(names.sort()).toEqual([...SBOMS, ...SBOMS.map((s) => `${s}${BUNDLE_SUFFIX}`)].sort());
  });

  it('verify-release checks the same four assets are attached', () => {
    const loop = release.match(/for a in ([^;]+); do\n\s+jq -e --arg a "\$a" '\.assets\[\]/);
    expect(loop, 'the asset-presence loop').not.toBeNull();
    const names = loop![1].replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
    expect(names.sort()).toEqual([...SBOMS, ...SBOMS.map((s) => `${s}${BUNDLE_SUFFIX}`)].sort());
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
