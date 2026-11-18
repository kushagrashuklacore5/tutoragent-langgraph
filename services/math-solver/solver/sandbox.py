"""Defence-in-depth limits for a solver worker process.

The primary guarantee is that user input is never executed (see safe_parse). These layers limit the
damage if that guarantee were ever broken, and stop runaway computations:

  layer                          Linux / macOS                    Windows
  -----------------------------  -------------------------------  --------------------------------
  wall-clock kill (server side)  yes (parent kills the worker)    yes (parent kills the worker)
  per-request CPU limit          RLIMIT_CPU soft limit (SIGXCPU)  no (wall-clock kill only)
  self-watchdog (os._exit)       yes                              yes
  memory cap                     RLIMIT_AS                        Job Object ProcessMemoryLimit
  no child processes             RLIMIT_NPROC=0 + audit hook      Job ActiveProcessLimit=1 + audit hook
  no file writes                 RLIMIT_FSIZE=0 + audit hook      audit hook
  no network                     audit hook (+ container          audit hook only (no OS-level
                                 --network none / internal net)   network isolation on Windows)

Python audit hooks (PEP 578) are not a security boundary on their own; they are a tripwire layered
on top of "no code execution" and, in production, an isolated no-network container.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from typing import Any

MEMORY_LIMIT_BYTES = int(os.environ.get("MATH_SOLVER_MEMORY_MB", "768")) * 1024 * 1024
CPU_SECONDS_PER_REQUEST = float(os.environ.get("MATH_SOLVER_CPU_SECONDS", "2"))

_BLOCKED_PREFIXES = (
    "socket.", "subprocess.", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork",
    "os.forkpty", "os.startfile", "os.kill", "os.remove", "os.unlink", "os.rename", "os.rmdir",
    "os.mkdir", "os.chmod", "os.chown", "os.truncate", "os.symlink", "os.link", "os.putenv",
    "os.unsetenv", "shutil.", "ctypes.", "winreg.", "urllib.", "http.client.", "ftplib.", "smtplib.",
    "poplib.", "imaplib.", "nntplib.", "telnetlib.", "webbrowser.", "pty.", "msvcrt.", "_winapi.",
    "sqlite3.", "mmap.", "fcntl.", "sys.addaudithook", "code.__new__",
    "builtins.input", "pdb.",
)
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC

applied: dict[str, Any] = {}


class SandboxViolation(RuntimeError):
    pass


def _allowed_read_roots() -> tuple[str, ...]:
    roots = {sys.prefix, sys.base_prefix, sys.exec_prefix, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))}
    return tuple(os.path.normcase(os.path.realpath(r)) + os.sep for r in roots)


def install_audit_hook() -> None:
    """Block process, network, write and native-code events. Reads only inside the Python install."""
    roots = _allowed_read_roots()

    def hook(event: str, args: tuple[Any, ...]) -> None:
        if event.startswith(_BLOCKED_PREFIXES):
            raise SandboxViolation(f"blocked by sandbox: {event}")
        if event == "open":
            path, mode, flags = (tuple(args) + (None, None, None))[:3]
            if isinstance(path, int):
                if path > 2:
                    raise SandboxViolation("blocked by sandbox: open fd")
                return
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int) and flags & _WRITE_FLAGS)
            if writing:
                raise SandboxViolation("blocked by sandbox: file write")
            p = os.fsdecode(path) if isinstance(path, (bytes, str)) else str(path)
            real = os.path.normcase(os.path.realpath(p))
            if not real.startswith(roots):
                raise SandboxViolation("blocked by sandbox: file read outside the runtime")

    sys.addaudithook(hook)
    applied["audit_hook"] = True


def _posix_limits() -> None:
    import resource

    def lower(which: int, value: int) -> None:
        try:
            soft, hard = resource.getrlimit(which)
            new_hard = value if hard == resource.RLIM_INFINITY else min(hard, value)
            resource.setrlimit(which, (min(value, new_hard), new_hard))
        except (ValueError, OSError):
            pass

    lower(resource.RLIMIT_AS, MEMORY_LIMIT_BYTES)
    lower(resource.RLIMIT_CORE, 0)
    lower(resource.RLIMIT_FSIZE, 0)
    if hasattr(resource, "RLIMIT_NPROC"):
        lower(resource.RLIMIT_NPROC, 0)
    applied.update(memory_bytes=MEMORY_LIMIT_BYTES, no_fork="RLIMIT_NPROC", no_file_writes="RLIMIT_FSIZE")


def _windows_job() -> None:
    import ctypes
    from ctypes import wintypes

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BASIC_LIMIT(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class EXTENDED_LIMIT(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BASIC_LIMIT), ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    LIMIT_ACTIVE_PROCESS, LIMIT_PROCESS_MEMORY = 0x8, 0x100
    LIMIT_DIE_ON_UNHANDLED_EXCEPTION, LIMIT_KILL_ON_JOB_CLOSE = 0x400, 0x2000
    ExtendedLimitInformation = 9

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    job = k32.CreateJobObjectW(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), "CreateJobObject failed")
    info = EXTENDED_LIMIT()
    info.BasicLimitInformation.LimitFlags = (LIMIT_ACTIVE_PROCESS | LIMIT_PROCESS_MEMORY |
                                             LIMIT_DIE_ON_UNHANDLED_EXCEPTION | LIMIT_KILL_ON_JOB_CLOSE)
    info.BasicLimitInformation.ActiveProcessLimit = 1
    info.ProcessMemoryLimit = MEMORY_LIMIT_BYTES
    if not k32.SetInformationJobObject(wintypes.HANDLE(job), ExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)):
        raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")
    if not k32.AssignProcessToJobObject(wintypes.HANDLE(job), wintypes.HANDLE(k32.GetCurrentProcess())):
        raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")
    applied.update(memory_bytes=MEMORY_LIMIT_BYTES, no_child_processes="JobObject ActiveProcessLimit=1", _job_handle=job)


def apply_os_limits() -> None:
    """Best effort; records what was applied in `applied` (reported by /health)."""
    try:
        if os.name == "nt":
            _windows_job()
        else:
            _posix_limits()
    except Exception as e:  # never fail open silently: report it
        applied["os_limits_error"] = f"{type(e).__name__}: {e}"


class CpuGuard:
    """Per-request CPU limit (POSIX RLIMIT_CPU soft limit) plus a cross-platform self-watchdog."""

    def __init__(self, watchdog_seconds: float) -> None:
        self.watchdog_seconds = watchdog_seconds
        self._deadline = 0.0
        self._lock = threading.Lock()
        threading.Thread(target=self._watch, daemon=True, name="watchdog").start()
        self._resource: Any = None
        if os.name != "nt":
            try:
                import resource
                self._resource = resource
                applied["cpu_seconds_per_request"] = CPU_SECONDS_PER_REQUEST
            except ImportError:
                pass

    def _watch(self) -> None:
        while True:
            time.sleep(0.25)
            with self._lock:
                d = self._deadline
            if d and time.monotonic() > d:
                os._exit(70)  # stuck past every other limit: die; the server replaces the worker

    def start(self) -> None:
        with self._lock:
            self._deadline = time.monotonic() + self.watchdog_seconds
        if self._resource is not None:
            r = self._resource
            used = r.getrusage(r.RUSAGE_SELF)
            total = used.ru_utime + used.ru_stime
            _, hard = r.getrlimit(r.RLIMIT_CPU)
            soft = int(total + CPU_SECONDS_PER_REQUEST) + 1
            if hard != r.RLIM_INFINITY:
                soft = min(soft, hard)
            r.setrlimit(r.RLIMIT_CPU, (soft, hard))

    def stop(self) -> None:
        with self._lock:
            self._deadline = 0.0
