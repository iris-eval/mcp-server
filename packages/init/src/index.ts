/*
 * Public API for @iris-eval/init.
 *
 * The CLI (cli.ts) is the primary surface. This file re-exports the
 * detection + config-writer functions for programmatic use (e.g. from
 * a Node script or a custom installer).
 */
export {
  type SupportedClient,
  type ClientProfile,
  configPathFor,
  profileFor,
  allProfiles,
  detectInstalledClients,
} from './detect.js';

export {
  type InstallResult,
  type UninstallResult,
  installIris,
  uninstallIris,
} from './config-writer.js';
