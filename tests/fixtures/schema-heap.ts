/*
 * The heap the schema checker keeps as it compiles, measured in a process of
 * its own. The heap test starts it with --expose-gc: where coverage is
 * collected, it keeps what it counts of every function compiled, and ajv
 * compiles one for every schema, so in the test's own process the heap grows
 * with coverage whatever the checker keeps.
 *
 * 300 schemas fill the cache of 256, the heap is settled, then 3,000 schemas
 * the cache cannot hold are compiled, and the heap is read after one
 * collection in the same job: what a list, or a WeakRef to the end of a job,
 * would keep is still there to be counted. Prints {"grownBytes": n}.
 *
 *   node --expose-gc --import tsx schema-heap.ts
 */
import { compileToolSchema } from '../../src/eval/schema-validator.js';

const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error('start this with --expose-gc');
const collect = gc;
const settled = async (): Promise<number> => {
  await new Promise((done) => setTimeout(done, 0));
  collect();
  await new Promise((done) => setTimeout(done, 0));
  collect();
  return process.memoryUsage().heapUsed;
};

compileToolSchema({ type: 'object', properties: { warm: { type: 'string' } } });
for (let i = 0; i < 300; i += 1) compileToolSchema({ type: 'object', properties: { [`w${i}`]: { type: 'string', maxLength: i + 1 } }, required: [`w${i}`] });
const start = await settled();
for (let i = 0; i < 3_000; i += 1) compileToolSchema({ type: 'object', properties: { [`g${i}`]: { type: 'string', maxLength: i + 1 }, [`h${i}`]: { type: 'integer', minimum: i } }, required: [`g${i}`] });
collect();
process.stdout.write(JSON.stringify({ grownBytes: process.memoryUsage().heapUsed - start }));
