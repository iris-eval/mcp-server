/*
 * An evaluator built twice in a fresh process, with or without the runtime
 * guard applied first, and the warnings of Iris's own that the process
 * emitted. The test reads the line this prints.
 *
 *   node --import tsx engine-warns.ts none     two evaluators, no guard
 *   node --import tsx engine-warns.ts guard    the guard, then two evaluators
 */
const mode = process.argv[2] ?? 'none';
if (mode === 'guard') await import('../../../src/apply-runtime-guard.js');

const codes: string[] = [];
process.on('warning', (warning) => codes.push(String((warning as NodeJS.ErrnoException).code ?? warning.name)));

const { EvalEngine } = await import('../../../src/eval/engine.js');
const { defaultConfig } = await import('../../../src/config/defaults.js');
const build = (): unknown => new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
build();
build();
// A warning reaches its listeners on a later turn of the loop.
await new Promise((resolve) => setTimeout(resolve, 100));
process.stdout.write(`WARNINGS ${JSON.stringify(codes.filter((code) => code.startsWith('IRIS_')))}\n`);

export {};
