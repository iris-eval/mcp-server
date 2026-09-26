/*
 * scripts/mcpb/pack.mjs and scripts/mcpb/archive.mjs — how the MCPB bundle
 * is built.
 *
 * What these pin: the ZIP writer is deterministic (same files, same bytes)
 * and its output reads back exactly; the tar reader takes the records npm
 * writes and refuses a path that escapes; the dependency closure is the
 * production tree from package-lock.json without better-sqlite3 and
 * without anything only it needs; and the packer refuses each input that
 * would make a bundle that cannot run — a version that disagrees, a
 * lockfile from another commit, an install that drifted from the lockfile,
 * a package that needs an install script, a native binary.
 *
 * The last test builds the real dependency set from this checkout's
 * node_modules twice and requires identical bytes. The built bundle is
 * started end to end by the CI mcpb job (tests/mcpb/).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-ignore — plain .mjs module
import { readTarball, readZip, writeZip } from '../scripts/mcpb/archive.mjs';
// @ts-ignore — plain .mjs module
import { bundleFiles, EXCLUDED_DEPENDENCIES, productionClosure, sha256 } from '../scripts/mcpb/pack.mjs';

const root = resolve(__dirname, '..');
type Files = Map<string, Buffer>;
type Lock = { packages: Record<string, { version?: string; dependencies?: Record<string, string>; dev?: boolean; hasInstallScript?: boolean; os?: string[]; cpu?: string[] }> };

/** One tar header + body, padded to 512-byte blocks. */
function tarEntry(name: string, data: Buffer, { type = '0', prefix = '' } = {}): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write('0000644\0', 100);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  if (prefix) header.write(prefix, 345, 'utf8');
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const body = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(body);
  return Buffer.concat([header, body]);
}
const tarball = (...entries: Buffer[]): Buffer => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const pax = (key: string, value: string): Buffer => {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length += 1;
  return Buffer.from(`${length}${body}`);
};

describe('the ZIP writer', () => {
  const files: Files = new Map([
    ['b.txt', Buffer.from('hello hello hello hello hello hello')],
    ['a/nested.json', Buffer.from('{"x":1}')],
    ['empty', Buffer.alloc(0)],
    ['z.bin', Buffer.from([0, 1, 2, 3, 255])],
  ]);

  it('reads back exactly what it wrote, whatever order the files came in', () => {
    const zip = writeZip(files);
    const back = readZip(zip) as Files;
    expect([...back.keys()]).toEqual(['a/nested.json', 'b.txt', 'empty', 'z.bin']);
    for (const [name, data] of files) expect(back.get(name)!.equals(data), name).toBe(true);
    expect(writeZip(new Map([...files].reverse())).equals(zip)).toBe(true);
  });

  it('is byte-identical across runs: one timestamp (1980-01-01), one mode (0644), no clock or machine in the bytes', () => {
    const zip = writeZip(files);
    expect(sha256(writeZip(files))).toBe(sha256(zip));
    // The central directory: every entry's date is 1980-01-01 and its mode 0644.
    let at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    for (let n = 0; n < files.size; n++) {
      expect(zip.readUInt16LE(at + 14)).toBe((1 << 5) | 1);
      expect(zip.readUInt16LE(at + 12)).toBe(0);
      expect(zip.readUInt32LE(at + 38) >>> 16).toBe(0o100644);
      at += 46 + zip.readUInt16LE(at + 28);
    }
  });

  it('deflates what compresses and stores what does not', () => {
    const zip = writeZip(files);
    const methods: Record<string, number> = {};
    let at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    for (let n = 0; n < files.size; n++) {
      methods[zip.subarray(at + 46, at + 46 + zip.readUInt16LE(at + 28)).toString()] = zip.readUInt16LE(at + 10);
      at += 46 + zip.readUInt16LE(at + 28);
    }
    expect(methods).toEqual({ 'a/nested.json': 0, 'b.txt': 8, empty: 0, 'z.bin': 0 });
  });

  it('refuses an archive whose contents fail their CRC', () => {
    const zip = Buffer.from(writeZip(new Map([['f', Buffer.from('abcdef')]])));
    zip[30 + 1] ^= 0xff; // the first byte of the stored body
    expect(() => readZip(zip)).toThrow(/CRC/);
  });
});

describe('the tar reader', () => {
  it('reads plain, ustar-prefixed, pax and GNU long-name entries under package/, and skips directories', () => {
    const long = `package/${'d/'.repeat(60)}long.js`;
    const gz = tarball(
      tarEntry('package/', Buffer.alloc(0), { type: '5' }),
      tarEntry('package/package.json', Buffer.from('{}')),
      tarEntry('index.js', Buffer.from('prefixed'), { prefix: 'package/dist' }),
      tarEntry('PaxHeader', pax('path', long), { type: 'x' }),
      tarEntry('truncated-name', Buffer.from('via pax')),
      tarEntry('././@LongLink', Buffer.from(`package/gnu/${'e'.repeat(120)}.js\0`), { type: 'L' }),
      tarEntry('truncated-too', Buffer.from('via gnu')),
    );
    const files = readTarball(gz) as Files;
    expect([...files.keys()]).toEqual(['package.json', 'dist/index.js', long.slice('package/'.length), `gnu/${'e'.repeat(120)}.js`]);
    expect(files.get('dist/index.js')!.toString()).toBe('prefixed');
    expect(files.get(long.slice('package/'.length))!.toString()).toBe('via pax');
  });

  it('refuses a path outside package/ or one that climbs out of it', () => {
    expect(() => readTarball(tarball(tarEntry('elsewhere/x.js', Buffer.from('x'))))).toThrow(/outside package\//);
    expect(() => readTarball(tarball(tarEntry('package/../x.js', Buffer.from('x'))))).toThrow(/refusing path/);
  });
});

describe('the dependency closure, from package-lock.json', () => {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as Lock;
  const closure = productionClosure(lock) as string[];

  it('leaves out better-sqlite3 and what only it needs, and nothing the server imports', () => {
    expect(Object.keys(EXCLUDED_DEPENDENCIES)).toEqual(['better-sqlite3']);
    expect(closure).not.toContain('node_modules/better-sqlite3');
    const withNative = productionClosure(lock, { exclude: [] }) as string[];
    const onlyForNative = withNative.filter((p) => !closure.includes(p));
    expect(onlyForNative).toContain('node_modules/better-sqlite3');
    expect(onlyForNative).toContain('node_modules/bindings');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    for (const dep of Object.keys(pkg.dependencies).filter((d) => d !== 'better-sqlite3')) expect(closure, dep).toContain(`node_modules/${dep}`);
  });

  it('is production-only, platform-neutral and needs no install script', () => {
    for (const at of closure) {
      const entry = lock.packages[at];
      expect(entry.dev, at).not.toBe(true);
      expect(entry.hasInstallScript, at).not.toBe(true);
      expect(entry.os, at).toBeUndefined();
      expect(entry.cpu, at).toBeUndefined();
    }
  });

  it('resolves a nested copy before a hoisted one, as Node does', () => {
    const fake: Lock = {
      packages: {
        '': { dependencies: { a: '1', b: '1' } },
        'node_modules/a': { version: '1.0.0', dependencies: { c: '2' } },
        'node_modules/a/node_modules/c': { version: '2.0.0' },
        'node_modules/b': { version: '1.0.0', dependencies: { c: '1' } },
        'node_modules/c': { version: '1.0.0' },
      },
    };
    expect(productionClosure(fake, { exclude: [] })).toEqual(['node_modules/a', 'node_modules/a/node_modules/c', 'node_modules/b', 'node_modules/c']);
    expect(() => productionClosure({ packages: { '': { dependencies: { missing: '1' } } } }, { exclude: [] })).toThrow(/missing .*not in package-lock.json/);
  });
});

describe('bundleFiles', () => {
  let dir: string;
  const manifest = { version: '1.2.3', icon: 'icon.png', server: { entry_point: 'dist/index.js' } };
  const packageFiles = (): Files =>
    new Map([
      ['package.json', Buffer.from(JSON.stringify({ name: 'x', version: '1.2.3', dependencies: { dep: '^1.0.0' } }))],
      ['dist/index.js', Buffer.from('console.log(1)')],
      ['LICENSE', Buffer.from('MIT')],
      ['README.md', Buffer.from('# x')],
    ]);
  const lock = (): Lock => ({
    packages: {
      '': { dependencies: { dep: '^1.0.0' } },
      'node_modules/dep': { version: '1.0.0' },
    },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-mcpb-pack-'));
    mkdirSync(join(dir, 'dep', 'lib'), { recursive: true });
    mkdirSync(join(dir, 'dep', 'node_modules', 'inner'), { recursive: true });
    writeFileSync(join(dir, 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }));
    writeFileSync(join(dir, 'dep', 'lib', 'index.js'), 'module.exports = 1');
    writeFileSync(join(dir, 'dep', 'node_modules', 'inner', 'package.json'), '{}');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const build = (overrides: Partial<{ packageFiles: Files; lock: Lock; manifest: unknown }> = {}) =>
    bundleFiles({ packageFiles: packageFiles(), lock: lock(), nodeModulesDir: dir, manifest, icon: Buffer.from('png'), ...overrides }) as { files: Files; packages: number };

  it('holds the package, the manifest, the icon and each dependency — not a dependency\'s nested node_modules', () => {
    const { files, packages } = build();
    expect(packages).toBe(1);
    expect([...files.keys()].sort()).toEqual(['LICENSE', 'README.md', 'dist/index.js', 'icon.png', 'manifest.json', 'node_modules/dep/lib/index.js', 'node_modules/dep/package.json', 'package.json']);
    expect(files.get('manifest.json')!.toString()).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
  });

  it('refuses a manifest whose version is not the package\'s', () => {
    expect(() => build({ manifest: { ...manifest, version: '9.9.9' } })).toThrow(/version 9\.9\.9 is not the package's 1\.2\.3/);
  });

  it('refuses a lockfile from another commit', () => {
    const other = lock();
    other.packages[''].dependencies = { dep: '^2.0.0' };
    expect(() => build({ lock: other })).toThrow(/root dependencies are not the package.json dependencies/);
  });

  it('refuses an install that drifted from the lockfile', () => {
    const other = lock();
    other.packages['node_modules/dep'].version = '1.0.1';
    expect(() => build({ lock: other })).toThrow(/dep is 1\.0\.0, package-lock\.json says 1\.0\.1/);
  });

  it('refuses a dependency that needs an install script', () => {
    const other = lock();
    other.packages['node_modules/dep'].hasInstallScript = true;
    expect(() => build({ lock: other })).toThrow(/install script/);
  });

  it('refuses a native binary anywhere in the bundle', () => {
    writeFileSync(join(dir, 'dep', 'lib', 'addon.node'), 'ELF');
    expect(() => build()).toThrow(/native binaries.*node_modules\/dep\/lib\/addon\.node/);
  });

  it('refuses a package missing a file the server cannot start without', () => {
    const files = packageFiles();
    files.delete('dist/index.js');
    expect(() => build({ packageFiles: files })).toThrow(/dist\/index\.js is missing/);
  });
});

describe('the bundle from this checkout', () => {
  it('builds the real dependency set twice into identical bytes, with no native binary', () => {
    const pkg = readFileSync(join(root, 'package.json'));
    const make = () =>
      writeZip(
        (bundleFiles({
          packageFiles: new Map([
            ['package.json', pkg],
            ['dist/index.js', Buffer.from('')],
            ['LICENSE', readFileSync(join(root, 'LICENSE'))],
            ['README.md', Buffer.from('')],
          ]),
          lock: JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')),
          nodeModulesDir: join(root, 'node_modules'),
          manifest: JSON.parse(readFileSync(join(root, 'mcpb', 'manifest.json'), 'utf8')),
          icon: readFileSync(join(root, 'mcpb', 'icon.png')),
        }) as { files: Files }).files,
      ) as Buffer;
    const first = make();
    expect(sha256(make())).toBe(sha256(first));
    const names = [...(readZip(first) as Files).keys()];
    expect(names.filter((n) => n.endsWith('.node'))).toEqual([]);
    expect(names.some((n) => n.startsWith('node_modules/better-sqlite3/'))).toBe(false);
    expect(names).toContain('node_modules/@modelcontextprotocol/sdk/package.json');
    // Two deflates of about 20 MB at level 9: seconds, not the default five.
  }, 60_000);
});
