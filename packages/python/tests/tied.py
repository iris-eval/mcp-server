"""Child processes that cannot outlive the test run that started them.

The end-to-end tests start an Iris server and a scripted provider as child
processes. A fixture's ``finally`` stops them when pytest ends normally,
but not when the run is killed outright: a CI step that times out, a
terminal closed mid-run, a hard kill from a tool. Those left servers
running, holding ports and files. Here each child is tied to this process
at three levels:

1. **The operating system**, so that even a hard kill of this process takes
   the children with it. On Windows every child joins a job object created
   with ``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE``: the only handle to the job is
   this process's, and when the process ends, however it ends, Windows closes
   that handle and kills everything in the job. On Linux each child asks the
   kernel for ``SIGKILL`` when its parent dies (``PR_SET_PDEATHSIG``). macOS
   has neither, and relies on the next two levels.
2. **Interpreter exit**: an ``atexit`` hook stops every child still running.
3. **Termination signals**: ``SIGTERM`` (and ``SIGHUP`` where it exists) stop
   the children before the default handling runs.

``spawn`` is a drop-in for ``subprocess.Popen``.
"""

from __future__ import annotations

import atexit
import ctypes
import os
import signal
import subprocess
import sys
import threading
from typing import Any

_children: list[subprocess.Popen[Any]] = []
_lock = threading.Lock()


def stop(proc: subprocess.Popen[Any]) -> None:
    """Kill one child and reap it; safe to call twice."""
    if proc.poll() is None:
        proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:  # pragma: no cover - a kill that did not land
        pass
    with _lock:
        if proc in _children:
            _children.remove(proc)


def stop_all() -> None:
    with _lock:
        running = list(_children)
    for proc in running:
        stop(proc)


# ---------- level 1: the operating system ----------

_job: int | None = None


def _windows_job() -> int:
    """One job object for the whole run, killing its members when this process's handle to it closes."""
    global _job
    if _job is not None:
        return _job
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]

    class IO_COUNTERS(ctypes.Structure):  # noqa: N801 - the Windows name
        _fields_ = [(n, ctypes.c_ulonglong) for n in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BASIC_LIMIT(ctypes.Structure):  # noqa: N801
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class EXTENDED_LIMIT(ctypes.Structure):  # noqa: N801
        _fields_ = [
            ("BasicLimitInformation", BASIC_LIMIT),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    info = EXTENDED_LIMIT()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel32.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ctypes.byref(info), ctypes.sizeof(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    _job = job
    return job


def _join_job(proc: subprocess.Popen[Any]) -> None:
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    if not kernel32.AssignProcessToJobObject(_windows_job(), wintypes.HANDLE(int(proc._handle))):  # type: ignore[attr-defined]
        raise ctypes.WinError(ctypes.get_last_error())


def _die_with_parent() -> None:  # pragma: no cover - runs in the child, between fork and exec
    PR_SET_PDEATHSIG = 1
    ctypes.CDLL("libc.so.6", use_errno=True).prctl(PR_SET_PDEATHSIG, signal.SIGKILL)


def spawn(args: list[str], **kwargs: Any) -> subprocess.Popen[Any]:
    """``subprocess.Popen``, with the child tied to this process at every level this platform has."""
    if sys.platform.startswith("linux"):
        kwargs.setdefault("preexec_fn", _die_with_parent)
    proc: subprocess.Popen[Any] = subprocess.Popen(args, **kwargs)
    if sys.platform == "win32":
        try:
            _join_job(proc)
        except OSError:
            proc.kill()
            raise
    with _lock:
        _children.append(proc)
    return proc


# ---------- levels 2 and 3: interpreter exit and termination signals ----------

atexit.register(stop_all)


def _on_signal(signum: int, frame: Any) -> None:
    stop_all()
    previous = _previous.get(signum)
    if callable(previous):
        previous(signum, frame)
    else:
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)


_previous: dict[int, Any] = {}
if threading.current_thread() is threading.main_thread():
    for _name in ("SIGTERM", "SIGHUP"):
        _sig = getattr(signal, _name, None)
        if _sig is not None:
            _previous[_sig] = signal.getsignal(_sig)
            signal.signal(_sig, _on_signal)
