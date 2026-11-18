"""Worker sandbox layers, exercised in a separate process (limits cannot be undone in-process)."""
import json
import os
import subprocess
import sys
import textwrap
import unittest

SERVICE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PROBE = textwrap.dedent(r"""
    import json, os, sys, tempfile
    from solver import sandbox
    from solver import ops  # noqa: F401  (import SymPy before locking down, like the worker)
    tmp = tempfile.gettempdir()
    sandbox.apply_os_limits()
    sandbox.install_audit_hook()
    results = {}
    def attempt(name, fn):
        try:
            fn()
            results[name] = "allowed"
        except sandbox.SandboxViolation:
            results[name] = "blocked"
        except MemoryError:
            results[name] = "memory_error"
        except Exception as e:
            results[name] = "error:" + type(e).__name__
    import socket, subprocess
    attempt("socket", lambda: socket.socket())
    attempt("connect", lambda: socket.create_connection(("127.0.0.1", 9)))
    attempt("subprocess", lambda: subprocess.run(["cmd" if os.name == "nt" else "true"]))
    attempt("os_system", lambda: os.system("echo hi"))
    attempt("write_file", lambda: open(os.path.join(tmp, "math-solver-sandbox-probe.txt"), "w"))
    attempt("read_outside", lambda: open(os.path.join(os.path.expanduser("~"), "x.txt")).read())
    attempt("remove", lambda: os.remove(os.path.join(tmp, "nope")))
    attempt("ctypes", lambda: __import__("ctypes").CDLL("libc.so.6" if os.name != "nt" else "kernel32"))
    attempt("read_stdlib", lambda: open(os.__file__).read(10))
    attempt("ops_after_lockdown", lambda: ops.run("equivalent", {"a": "x^2-1", "b": "(x-1)*(x+1)"}))
    attempt("memory_2gb", lambda: bytearray(2 * 1024 * 1024 * 1024))
    sys.stdout.write(json.dumps({"results": results, "applied": {k: v for k, v in sandbox.applied.items() if not k.startswith("_")}}))
""")


class SandboxLayers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        out = subprocess.run([sys.executable, "-c", PROBE], cwd=SERVICE_DIR, capture_output=True, timeout=120,
                             env={**os.environ, "MATH_SOLVER_MEMORY_MB": "512"})
        assert out.returncode == 0, out.stderr.decode(errors="replace")
        cls.report = json.loads(out.stdout)
        cls.r = cls.report["results"]

    def test_network_blocked(self):
        self.assertEqual(self.r["socket"], "blocked")
        self.assertEqual(self.r["connect"], "blocked")

    def test_processes_blocked(self):
        self.assertEqual(self.r["subprocess"], "blocked")
        self.assertEqual(self.r["os_system"], "blocked")

    def test_filesystem_restricted(self):
        self.assertEqual(self.r["write_file"], "blocked")
        self.assertEqual(self.r["read_outside"], "blocked")
        self.assertEqual(self.r["remove"], "blocked")
        self.assertEqual(self.r["read_stdlib"], "allowed")

    def test_native_code_blocked(self):
        self.assertEqual(self.r["ctypes"], "blocked")

    def test_solver_still_works(self):
        self.assertEqual(self.r["ops_after_lockdown"], "allowed")

    def test_memory_cap(self):
        self.assertNotIn("os_limits_error", self.report["applied"])
        self.assertEqual(self.report["applied"].get("memory_bytes"), 512 * 1024 * 1024)
        self.assertEqual(self.r["memory_2gb"], "memory_error")


if __name__ == "__main__":
    unittest.main()
