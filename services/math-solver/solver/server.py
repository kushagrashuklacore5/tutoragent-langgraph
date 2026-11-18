"""HTTP front for the solver (Python standard library only).

    python -m solver.server [--host 127.0.0.1] [--port 8765] [--workers 2] [--timeout 2.0]

Endpoints
  GET  /health                 {"status": "ok"|"degraded", "workers": {...}, "version": ...}
  POST /v1/<operation>         body: JSON arguments for the operation; response: result JSON

Each request is handed to a pre-started worker process (SymPy import takes ~1 s, so a process per
request would be too slow). If the worker does not answer within the wall-clock timeout it is killed
and replaced, and the response is {"ok": false, "verdict": "unverified", "reason": "timeout"}.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import VERSION

SERVICE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OPERATIONS = ("equivalent", "check_steps", "numeric_check", "evaluate", "convert_units")
MAX_BODY_BYTES = 16 * 1024
LOOPBACK = ("127.0.0.1", "::1", "localhost")


def _unverified(reason: str, detail: str) -> dict[str, Any]:
    return {"ok": False, "verdict": "unverified", "reason": reason, "detail": detail}


class Worker:
    def __init__(self) -> None:
        env = {"PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
        for k in ("SYSTEMROOT", "MATH_SOLVER_MEMORY_MB", "MATH_SOLVER_CPU_SECONDS", "MATH_SOLVER_WATCHDOG_SECONDS"):
            if k in os.environ:
                env[k] = os.environ[k]
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "solver.worker"], cwd=SERVICE_DIR, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags,
        )
        self.lines: queue.Queue[bytes] = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.sandbox: dict[str, Any] = {}

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.lines.put(line)
        self.lines.put(b"")  # EOF marker

    def wait_ready(self, timeout: float) -> bool:
        try:
            line = self.lines.get(timeout=timeout)
            msg = json.loads(line) if line else {}
            self.sandbox = msg.get("sandbox", {})
            return bool(msg.get("ready"))
        except (queue.Empty, ValueError):
            return False

    def call(self, op: str, args: Any, timeout: float) -> dict[str, Any] | None:
        """Returns the result, or None if the worker timed out or died (it must then be discarded)."""
        assert self.proc.stdin is not None
        try:
            self.proc.stdin.write(json.dumps({"op": op, "args": args}).encode() + b"\n")
            self.proc.stdin.flush()
            line = self.lines.get(timeout=timeout)
        except (OSError, queue.Empty, ValueError):
            return None
        if not line:
            return None
        try:
            res = json.loads(line)
        except ValueError:
            return None
        return res if isinstance(res, dict) else None

    def kill(self) -> None:
        try:
            self.proc.kill()
            self.proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass


class Pool:
    def __init__(self, size: int, timeout: float, startup_timeout: float = 60.0) -> None:
        self.size = size
        self.timeout = timeout
        self.startup_timeout = startup_timeout
        self.idle: queue.Queue[Worker] = queue.Queue()
        self.sandbox: dict[str, Any] = {}
        self._lock = threading.Lock()
        self.starting = 0
        self.stats = {"requests": 0, "timeouts": 0, "worker_restarts": 0}
        for _ in range(size):
            self._spawn_async()

    def _spawn_async(self) -> None:
        with self._lock:
            self.starting += 1
        threading.Thread(target=self._spawn, daemon=True).start()

    def _spawn(self) -> None:
        try:
            for _attempt in range(3):
                w = Worker()
                if w.wait_ready(self.startup_timeout):
                    self.sandbox = w.sandbox
                    self.idle.put(w)
                    return
                w.kill()
                time.sleep(1)
        finally:
            with self._lock:
                self.starting -= 1

    def ready_count(self) -> int:
        return self.idle.qsize()

    def run(self, op: str, args: Any, queue_timeout: float) -> tuple[int, dict[str, Any]]:
        try:
            w = self.idle.get(timeout=queue_timeout)
        except queue.Empty:
            return 503, _unverified("busy", "no solver worker became available")
        with self._lock:
            self.stats["requests"] += 1
        res = w.call(op, args, self.timeout)
        if res is None:
            w.kill()
            with self._lock:
                self.stats["timeouts"] += 1
                self.stats["worker_restarts"] += 1
            self._spawn_async()
            return 504, _unverified("timeout", f"no result within {self.timeout:g} s")
        self.idle.put(w)
        return 200, res

    def close(self) -> None:
        while True:
            try:
                self.idle.get_nowait().kill()
            except queue.Empty:
                return


def make_handler(pool: Pool, queue_timeout: float) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "math-solver"
        sys_version = ""
        protocol_version = "HTTP/1.1"
        timeout = 10  # socket read timeout (slow clients)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - silence access log
            pass

        def _send(self, status: int, body: dict[str, Any]) -> None:
            data = json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/health":
                return self._send(404, {"ok": False, "verdict": "invalid", "reason": "not_found"})
            ready = pool.ready_count()
            self._send(200, {
                "status": "ok" if ready > 0 else "degraded", "version": VERSION,
                "workers": {"size": pool.size, "idle": ready, "starting": pool.starting},
                "timeoutSeconds": pool.timeout, "sandbox": pool.sandbox, "stats": pool.stats,
            })

        def do_POST(self) -> None:  # noqa: N802
            if not self.path.startswith("/v1/") or self.path[4:] not in OPERATIONS:
                self.close_connection = True
                return self._send(404, {"ok": False, "verdict": "invalid", "reason": "unknown_operation"})
            length_h = self.headers.get("Content-Length")
            if length_h is None or not length_h.isdigit():
                self.close_connection = True
                return self._send(411, {"ok": False, "verdict": "invalid", "reason": "length_required"})
            length = int(length_h)
            if length > MAX_BODY_BYTES:
                self.close_connection = True
                return self._send(413, {"ok": False, "verdict": "invalid", "reason": "request_too_large"})
            try:
                args = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeDecodeError):
                return self._send(400, {"ok": False, "verdict": "invalid", "reason": "invalid_json"})
            status, res = pool.run(self.path[4:], args, queue_timeout)
            self._send(status, res)

    return Handler


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Ek Bharat.AI maths solver sidecar")
    ap.add_argument("--host", default=os.environ.get("MATH_SOLVER_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("MATH_SOLVER_PORT", "8765")))
    ap.add_argument("--workers", type=int, default=int(os.environ.get("MATH_SOLVER_WORKERS", "2")))
    ap.add_argument("--timeout", type=float, default=float(os.environ.get("MATH_SOLVER_TIMEOUT_SECONDS", "2")))
    ap.add_argument("--queue-timeout", type=float, default=5.0)
    ap.add_argument("--allow-non-loopback", action="store_true",
                    help="only for the isolated container, where the network itself is internal-only")
    a = ap.parse_args(argv)
    if a.host not in LOOPBACK and not a.allow_non_loopback:
        ap.error("refusing to bind a non-loopback address without --allow-non-loopback")
    if not 1 <= a.workers <= 32 or not 0.1 <= a.timeout <= 30:
        ap.error("workers must be 1..32 and timeout 0.1..30 s")

    pool = Pool(a.workers, a.timeout)
    httpd = ThreadingHTTPServer((a.host, a.port), make_handler(pool, a.queue_timeout))
    httpd.daemon_threads = True
    host, port = httpd.server_address[:2]
    print(f"math-solver listening on http://{host}:{port}", flush=True)
    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        pool.close()


if __name__ == "__main__":
    main()
