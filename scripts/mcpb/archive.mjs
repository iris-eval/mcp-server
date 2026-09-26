/*
 * The two archive formats the MCPB bundle touches, with no dependency.
 *
 *   readTarball   the npm package (.tgz) the bundle is built from
 *   writeZip      the bundle itself (.mcpb is a ZIP archive)
 *   readZip       the bundle, read back by the tests and the smoke check
 *
 * writeZip is deterministic by construction: entries are written in sorted
 * order, every entry carries the same timestamp (1980-01-01 00:00, the
 * earliest a ZIP can record) and the same permissions (0644), and nothing
 * about the machine or the clock reaches the bytes. The only input besides
 * the files is the deflate implementation, which is Node's own zlib.
 */
import { crc32, deflateRawSync, gunzipSync, inflateRawSync } from 'node:zlib';

/* ---- tar (ustar, with the pax and GNU long-name records npm may write) ---- */

function field(block, offset, length) {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? length : end).toString('utf8');
}

function octal(block, offset, length) {
  // Base-256 (a set high bit) is how tar writes sizes over 8 GiB; no package file is that large.
  if (block[offset] & 0x80) throw new Error('tar: base-256 sizes are not supported');
  const text = field(block, offset, length).trim();
  return text === '' ? 0 : parseInt(text, 8);
}

function paxPath(data) {
  // Records are "<length> <key>=<value>\n"; only the path matters here.
  let at = 0;
  let path;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = parseInt(data.subarray(at, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    at += length;
  }
  return path;
}

/**
 * The regular files of a gzipped tarball, as a Map of path → bytes. npm
 * packs every file under `package/`; `strip` removes that first segment.
 */
export function readTarball(gz, { strip = 'package/' } = {}) {
  const tar = gunzipSync(gz);
  const files = new Map();
  let at = 0;
  let nextPath;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      nextPath = paxPath(data) ?? nextPath;
      continue;
    }
    if (type === 'L') {
      nextPath = field(data, 0, data.length);
      continue;
    }
    if (type === 'g') continue;
    const prefix = field(header, 345, 155);
    const name = nextPath ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    nextPath = undefined;
    if (type !== '0' && type !== '\0') continue; // directories, links: npm packs regular files only
    if (!name.startsWith(strip)) throw new Error(`tar: ${name} is outside ${strip}`);
    const rel = name.slice(strip.length);
    if (rel === '' || rel.split('/').some((s) => s === '..' || s === '')) throw new Error(`tar: refusing path ${name}`);
    files.set(rel, Buffer.from(data));
  }
  return files;
}

/* ---- zip ---- */

const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;
const UNIX_FILE_0644 = (0o100644 << 16) >>> 0;
const MADE_BY_UNIX = (3 << 8) | 20;
const UTF8_NAMES = 0x0800;

/**
 * A ZIP archive of `files` (path → bytes), byte-for-byte the same for the
 * same input. Each entry is deflated at level 9, or stored when deflate
 * would not make it smaller.
 */
export function writeZip(files) {
  const names = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (names.length > 0xffff) throw new Error(`zip: ${names.length} entries needs ZIP64, which this writer does not produce`);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const data = files.get(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(UNIX_FILE_0644, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
    if (offset > 0xffffffff) throw new Error('zip: archive over 4 GiB needs ZIP64');
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * The files of a ZIP archive (path → bytes), read from its central
 * directory. Checks every CRC. Handles stored and deflated entries — what
 * writeZip produces and what `mcpb pack` produces.
 */
export function readZip(zip) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: no end-of-central-directory record');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const localData = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const body = zip.subarray(localData, localData + compressed);
    const data = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body) : null;
    if (!data) throw new Error(`zip: ${name} uses compression method ${method}`);
    if (crc32(data) !== crc) throw new Error(`zip: ${name} fails its CRC check`);
    files.set(name, data);
  }
  return files;
}
