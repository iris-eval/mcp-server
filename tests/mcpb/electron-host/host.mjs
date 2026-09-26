/*
 * The utility-process side of main.mjs: stdio over a MessagePort.
 *
 * A utility process has no stdin a parent can write JSON-RPC into, so the
 * host hands it a MessagePort, redirects process.stdout.write to post each
 * chunk, turns each posted message into a line on a stream standing in for
 * process.stdin, and only then imports the server's entry point — which
 * sees the command line `node <entry> ...args` it would see under Node.
 */
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const [entry, ...args] = process.argv.slice(2);

process.parentPort.once('message', ({ data, ports }) => {
  if (data?.type !== 'init' || !ports?.[0]) {
    console.error('host: expected an init message carrying a port');
    process.exit(1);
  }
  const port = ports[0];

  process.stdout.write = (chunk, encoding, callback) => {
    port.postMessage({ type: 'stdout', content: chunk.toString() });
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) process.nextTick(done);
    return true;
  };

  const input = new Readable({ read() {} });
  for (const method of ['on', 'once', 'off', 'addListener', 'removeListener', 'removeAllListeners', 'pause', 'resume', 'read', 'pipe', 'unpipe', 'setEncoding', 'destroy', 'isPaused']) {
    process.stdin[method] = input[method].bind(input);
  }
  port.on('message', ({ data: message }) => {
    if (message.type === 'stdin') input.push(`${message.data}\n`);
  });
  port.start();

  process.argv = [process.platform === 'win32' ? 'node.exe' : 'node', entry, ...args];
  import(pathToFileURL(resolve(entry)).href).catch((err) => {
    console.error('host: the server failed to load:', err);
    process.exit(1);
  });
});
