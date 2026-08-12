/*
 * Raw node:http request helper.
 *
 * node:http, NOT fetch — deliberately, and everywhere, not just for the
 * hostile-header checks. fetch() silently drops forbidden headers
 * (Host chief among them), so a fetch-based rebinding probe asserts
 * nothing at all while looking green. Using one transport for every
 * request also means the harness never has two different header
 * behaviours to reason about.
 */
import { request as httpRequest } from 'node:http';

export function raw({
  port,
  method = 'GET',
  path = '/',
  headers = {},
  body,
  host = '127.0.0.1',
  timeoutMs = 15_000,
}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const finalHeaders = { Connection: 'close', ...headers };
    if (payload !== undefined) {
      if (!Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'content-type')) {
        finalHeaders['Content-Type'] = 'application/json';
      }
      finalHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = httpRequest(
      { host, port, path, method, headers: finalHeaders, setHost: !hasHostHeader(headers) },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
        });
        res.once('end', () => {
          let json;
          try {
            json = JSON.parse(buf);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms: ${method} ${path}`));
    });
    req.once('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function hasHostHeader(headers) {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'host');
}

/** GET + parse, throwing when the response is not the expected status. */
export async function getJson(port, path, expectStatus = 200) {
  const res = await raw({ port, path });
  if (res.status !== expectStatus) {
    throw new Error(`GET ${path}: expected ${expectStatus}, got ${res.status} — body ${res.body.slice(0, 200)}`);
  }
  if (res.json === undefined) {
    throw new Error(`GET ${path}: response was not JSON — ${res.body.slice(0, 200)}`);
  }
  return res.json;
}

export async function postJson(port, path, body, expectStatus) {
  const res = await raw({ port, method: 'POST', path, body });
  if (expectStatus !== undefined && res.status !== expectStatus) {
    throw new Error(`POST ${path}: expected ${expectStatus}, got ${res.status} — body ${res.body.slice(0, 200)}`);
  }
  return res;
}
