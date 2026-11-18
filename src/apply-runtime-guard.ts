/*
 * Imported FIRST by every entry point Iris owns, for what it does when it
 * is loaded: it turns off the compiler tier that can make two results share
 * their numbers (runtime-guard.ts), before any other module has run.
 * An import is evaluated in the order it is written, so nothing may stand
 * above this one in a file that imports it.
 */
import { applyRuntimeGuard } from './runtime-guard.js';

applyRuntimeGuard();
