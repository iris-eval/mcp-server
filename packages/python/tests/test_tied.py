"""The end-to-end helpers never leave a server running.

A driver process starts the real Iris server and the scripted provider
through ``live.py``, exactly as the test fixtures do, reports their process
ids, and then ends in one of the ways a test run ends early. Each case
requires both children to be gone within seconds:

- killed outright (``TerminateProcess`` on Windows, ``SIGKILL`` on Linux):
  no Python code runs, so only the operating-system tie can stop them;
- exiting without running any fixture finalizer: the ``atexit`` hook (the
  operating-system tie and the server's own end-of-stdin exit also apply, so
  this case holds the outcome, not one mechanism);
- sent ``SIGTERM`` (not on Windows, where there is no such signal to catch).

macOS has no kernel tie, so the hard-kill case does not apply there; the
Python client's CI job runs on Linux.
"""

from __future__ import annotations

import ctypes
import json
import os
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from live import require_prerequisites

TESTS = Path(__file__).resolve().parent

DRIVER = textwrap.dedent(
    """
    import json, sys, time
    sys.path.insert(0, {tests!r})
    import live, tied
    iris = live.start_iris(); next(iris)
    provider = live.start_provider(); next(provider)
    print(json.dumps([p.pid for p in tied._children]), flush=True)
    how = sys.argv[1]
    if how == "exit":
        sys.stdin.readline() # until the test has seen the children running
        sys.exit(0)          # no generator is closed: no fixture finalizer runs
    time.sleep(600)          # wait to be killed or signalled
    """
)


def alive(pid: int) -> bool:
    if sys.platform == "win32":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # pragma: no cover - a pid reused by another user's process
        return True
    return True


def gone_within(pids: list[int], seconds: float) -> list[int]:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        left = [p for p in pids if alive(p)]
        if not left:
            return []
        time.sleep(0.1)
    return [p for p in pids if alive(p)]


def start_driver(how: str) -> tuple[subprocess.Popen[str], list[int]]:
    require_prerequisites()
    driver = subprocess.Popen([sys.executable, "-c", DRIVER.format(tests=str(TESTS)), how], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert driver.stdout is not None
    line = driver.stdout.readline()
    try:
        pids = json.loads(line)
    except ValueError:
        driver.kill()
        raise AssertionError(f"the driver did not start its children: {line!r} {driver.stderr.read() if driver.stderr else ''}")
    assert len(pids) == 2 and all(alive(p) for p in pids)
    return driver, pids


@pytest.mark.skipif(sys.platform == "darwin", reason="macOS has no kernel tie from a child to its parent; atexit and signals cover it")
def test_a_hard_kill_of_the_run_takes_its_servers_with_it() -> None:
    driver, pids = start_driver("sleep")
    driver.kill()  # TerminateProcess / SIGKILL: nothing in the driver runs
    driver.wait(timeout=10)
    assert gone_within(pids, 10) == []


def test_a_run_that_exits_without_its_finalizers_stops_its_servers() -> None:
    driver, pids = start_driver("exit")
    assert driver.stdin is not None
    driver.stdin.write("go\n")
    driver.stdin.flush()
    assert driver.wait(timeout=30) == 0
    assert gone_within(pids, 10) == []


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has no SIGTERM to catch; a terminate there is the hard kill above")
def test_sigterm_stops_the_servers() -> None:
    driver, pids = start_driver("sleep")
    driver.send_signal(signal.SIGTERM)
    driver.wait(timeout=10)
    assert gone_within(pids, 10) == []
