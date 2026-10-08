// A preload for tests/unit/scripts/check-tools-listed.test.ts.
//
// check-tools-listed.mjs starts the server and writes to its stdin in the same
// tick. On an idle machine the server is still starting when that write lands.
// On a busy one the script can be held long enough for the server to exit
// first, and the write then fails with EPIPE. This preload makes that order
// certain: after spawn() returns it holds the thread until the stand-in server
// has recorded its environment (the line before it exits in "exit" mode), then
// a little longer for the exit itself.
import cp from 'node:child_process';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const realSpawn = cp.spawn;

function hold(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* hold the thread, as a descheduled process is held */
  }
}

cp.spawn = function spawnThenHold(...args) {
  const child = realSpawn.apply(this, args);
  const recorded = process.env.STAND_IN_ENV_OUT;
  const giveUp = Date.now() + 20_000;
  while (recorded && !existsSync(recorded) && Date.now() < giveUp) hold(5);
  hold(500);
  return child;
};

syncBuiltinESMExports();
