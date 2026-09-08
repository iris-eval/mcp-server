#!/usr/bin/env node
/*
 * verify-release — F1–F6 from outside, the local form of the release
 * workflow's `verify-release` job (A6-9).
 *
 * The job in .github/workflows/release.yml is the gate; this script is the
 * instrument the release record quotes, so the record stops replicating
 * the job's steps by hand. It reads every external surface a release is
 * supposed to move and compares each with the version:
 *
 *   F1 npm       the dist-tag (`latest`, or `next` for a pre-release) resolves to it
 *   F2 GHCR      the `v<version>` tag and (production) `:latest` resolve, and to one digest
 *   F3 release   the GitHub release is published, typed right, carries the four SBOM
 *                assets and the CHANGELOG section (signature verification stays the job's:
 *                it needs cosign)
 *   F4 registry  the Official MCP Registry's `latest` is this version, isLatest true
 *   F5 site      iris-eval.com/.well-known/mcp.json says the version, and /llms.txt,
 *                /proof, /capabilities name it
 *   F6 install   `npx -y <package>@<version> --self-test` passes in an empty directory
 *                with a scratch home
 *
 * Usage:
 *   node scripts/verify-release.mjs                # the version in package.json
 *   node scripts/verify-release.mjs --version 0.13.0
 *   node scripts/verify-release.mjs --skip-install # F1–F5 only
 *
 * Every row prints ✓ or ✗ with what it read; the exit code is 1 if any row
 * is ✗. Nothing here writes anywhere but a temp directory for F6.
 */
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const skipInstall = args.includes('--skip-install');

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf-8'));
const serverJson = JSON.parse(await readFile(resolve(root, 'server.json'), 'utf-8'));
const claims = JSON.parse(await readFile(resolve(root, '.claims.json'), 'utf-8'));

const version = flag('--version') ?? pkg.version;
const prerelease = !/^\d+\.\d+\.\d+$/.test(version);
const distTag = prerelease ? 'next' : 'latest';
const npmPackage = pkg.name; // @iris-eval/mcp-server
const repo = claims.brand.publicRepoUrl.replace(/^https:\/\/github\.com\//, ''); // iris-eval/mcp-server
const site = claims.brand.websiteUrl;

/*
 * Windows resolves `gh` and `npx` to .cmd shims, which need a shell; the
 * command is joined into one string there so the shell sees exactly one
 * line (passing an args array with shell:true is deprecated). Elsewhere the
 * args array goes straight to the executable.
 */
function run(cmd, args, opts) {
  return process.platform === 'win32'
    ? spawnSync([cmd, ...args].join(' '), { ...opts, shell: true })
    : spawnSync(cmd, args, opts);
}

const rows = [];
function row(id, ok, detail) {
  rows.push({ id, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${id} — ${detail}`);
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// F1 — npm
try {
  const tags = await getJson(`https://registry.npmjs.org/-/package/${encodeURIComponent(npmPackage)}/dist-tags`);
  row('F1 npm', tags[distTag] === version, `dist-tag ${distTag} = ${tags[distTag] ?? '?'} (want ${version})`);
} catch (err) {
  row('F1 npm', false, `could not read dist-tags: ${err.message}`);
}

// F2 — GHCR: anonymous pull token, HEAD on each manifest
try {
  const { token } = await getJson(`https://ghcr.io/token?scope=repository:${repo}:pull`);
  const digestOf = async (ref) => {
    const res = await fetch(`https://ghcr.io/v2/${repo}/manifests/${ref}`, {
      method: 'HEAD',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
      },
    });
    return res.ok ? res.headers.get('docker-content-digest') : null;
  };
  const tagged = await digestOf(`v${version}`);
  const latest = prerelease ? null : await digestOf('latest');
  const ok = Boolean(tagged) && (prerelease || latest === tagged);
  row('F2 GHCR', ok, `ghcr.io/${repo}:v${version} = ${tagged ?? 'missing'}${prerelease ? '' : `; :latest = ${latest ?? 'missing'}`}`);
} catch (err) {
  row('F2 GHCR', false, `could not read the registry: ${err.message}`);
}

// F3 — the GitHub release (gh reads it; the SBOM signatures stay the workflow's row)
{
  const gh = run('gh', ['release', 'view', `v${version}`, '-R', repo, '--json', 'isDraft,isPrerelease,assets,body'], { encoding: 'utf-8' });
  if (gh.status !== 0) {
    row('F3 release', false, `gh release view failed: ${(gh.stderr || gh.stdout || '').trim().slice(0, 200)}`);
  } else {
    const rel = JSON.parse(gh.stdout);
    const names = new Set((rel.assets ?? []).map((a) => a.name));
    const wanted = ['iris-npm-sbom.spdx.json', 'iris-npm-sbom.spdx.json.sigstore.json', 'iris-docker-sbom.spdx.json', 'iris-docker-sbom.spdx.json.sigstore.json'];
    const missing = wanted.filter((n) => !names.has(n));
    const notes = prerelease || String(rel.body ?? '').includes(`[${version}]`);
    const ok = rel.isDraft === false && rel.isPrerelease === prerelease && missing.length === 0 && notes;
    row('F3 release', ok, `draft=${rel.isDraft} prerelease=${rel.isPrerelease} sbom assets missing=[${missing.join(', ')}] changelog section=${notes}`);
  }
}

// F4 — the Official MCP Registry
try {
  const encoded = encodeURIComponent(serverJson.name);
  const body = await getJson(`https://registry.modelcontextprotocol.io/v0.1/servers/${encoded}/versions/latest`);
  const got = body?.server?.version;
  const isLatest = body?._meta?.['io.modelcontextprotocol.registry/official']?.isLatest;
  row('F4 registry', got === version && isLatest === true, `${serverJson.name} latest = ${got ?? '?'} isLatest=${isLatest ?? '?'}`);
} catch (err) {
  row('F4 registry', false, `could not read the registry: ${err.message}`);
}

// F5 — the live site
try {
  const manifest = await getJson(`${site}/.well-known/mcp.json?rel=${version}`);
  const pages = [];
  for (const path of ['llms.txt', 'proof', 'capabilities']) {
    const res = await fetch(`${site}/${path}?rel=${version}`);
    const text = res.ok ? await res.text() : '';
    pages.push([path, text.includes(version)]);
  }
  const ok = manifest.version === version && pages.every(([, hit]) => hit);
  row('F5 site', ok, `.well-known/mcp.json = ${manifest.version}; ${pages.map(([p, hit]) => `/${p} ${hit ? 'names' : 'does not name'} ${version}`).join(', ')}`);
} catch (err) {
  row('F5 site', false, `could not read the site: ${err.message}`);
}

// F6 — a fresh install passes its own self-test
if (skipInstall) {
  row('F6 install', true, 'skipped (--skip-install)');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'iris-verify-release-'));
  const home = join(dir, 'home');
  try {
    const r = run('npx', ['-y', `${npmPackage}@${version}`, '--self-test'], {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1' },
      timeout: 240_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const pass = r.status === 0 && /PASS — this install works/.test(out);
    const versionLine = out.match(/self-test v(\S+)/)?.[1];
    row('F6 install', pass && versionLine === version, `npx ${npmPackage}@${version} --self-test → exit ${r.status}, self-test v${versionLine ?? '?'}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const failed = rows.filter((r) => !r.ok);
console.log(failed.length === 0 ? `\nAll ${rows.length} rows agree with ${version}.` : `\n${failed.length} of ${rows.length} rows disagree with ${version}.`);
process.exit(failed.length === 0 ? 0 : 1);
