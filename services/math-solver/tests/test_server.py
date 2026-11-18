"""End-to-end over HTTP: real server, real worker processes, timeout kill and replacement."""
import json
import os
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request

SERVICE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SLOW = {"a": "(x+y+z+w+1)^12*sin(x)^2", "b": "(x+y+z+w+1)^12*(1-cos(x)^2)"}  # ~25 s of simplify


def post(base, op, body, raw=None):
    data = raw if raw is not None else json.dumps(body).encode()
    req = urllib.request.Request(f"{base}/v1/{op}", data=data, method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def health(base):
    with urllib.request.urlopen(f"{base}/health", timeout=5) as r:
        return json.loads(r.read())


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc = subprocess.Popen([sys.executable, "-m", "solver.server", "--port", "0", "--workers", "1", "--timeout", "1.5"],
                                    cwd=SERVICE_DIR, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        line = cls.proc.stdout.readline().decode()
        cls.base = line.strip().rsplit(" ", 1)[-1]
        assert cls.base.startswith("http://127.0.0.1:"), line
        cls.wait_ready()

    @classmethod
    def wait_ready(cls):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if health(cls.base)["workers"]["idle"] > 0:
                return
            time.sleep(0.2)
        raise AssertionError("worker never became ready")

    @classmethod
    def tearDownClass(cls):
        cls.proc.kill()
        cls.proc.wait(10)

    def test_health_reports_sandbox(self):
        h = health(self.base)
        self.assertEqual(h["status"], "ok")
        self.assertTrue(h["sandbox"].get("audit_hook"))

    def test_operation_roundtrip(self):
        status, r = post(self.base, "equivalent", {"a": "(x+1)^2", "b": "x^2+2*x+1"})
        self.assertEqual((status, r["ok"], r["verdict"]), (200, True, "pass"))

    def test_malicious_input_is_invalid(self):
        status, r = post(self.base, "evaluate", {"expr": "__import__('os').system('echo pwned')"})
        self.assertEqual((status, r["ok"], r["verdict"]), (200, False, "invalid"))

    def test_bad_requests(self):
        self.assertEqual(post(self.base, "nope", {})[0], 404)
        self.assertEqual(post(self.base, "evaluate", None, raw=b"{not json")[0], 400)
        status, r = post(self.base, "evaluate", {"expr": "x" * 20000})
        self.assertEqual((status, r["reason"]), (413, "request_too_large"))

    def test_timeout_kills_worker_and_recovers(self):
        t0 = time.monotonic()
        status, r = post(self.base, "equivalent", SLOW)
        self.assertLess(time.monotonic() - t0, 5)
        self.assertEqual((status, r["ok"], r["verdict"], r["reason"]), (504, False, "unverified", "timeout"))
        self.wait_ready()
        status, r = post(self.base, "evaluate", {"expr": "2^10"})
        self.assertEqual((status, r["exact"]), (200, "1024"))
        self.assertGreaterEqual(health(self.base)["stats"]["worker_restarts"], 1)


class Binding(unittest.TestCase):
    def test_refuses_non_loopback(self):
        out = subprocess.run([sys.executable, "-m", "solver.server", "--host", "0.0.0.0", "--port", "0"],
                             cwd=SERVICE_DIR, capture_output=True, timeout=30)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn(b"non-loopback", out.stderr)


if __name__ == "__main__":
    unittest.main()
