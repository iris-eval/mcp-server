/*
 * Global vitest setup, listed first: every test worker turns off the
 * compiler tier that can make two results share their numbers before a test
 * file loads (src/runtime-guard.ts). A test worker is a process that starts
 * beside others on a busy machine, which is where the defect was measured:
 * without this a number a test reads can be another object's, in whichever
 * file was unlucky, and not when it is run again.
 *
 * A test that needs to see the unguarded state asks guardStateOf with facts
 * of its own; none turns the tier back on.
 */
import '../../src/apply-runtime-guard.js';
