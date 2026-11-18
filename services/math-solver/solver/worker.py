"""Solver worker: one JSON request per line on stdin, one JSON result per line on stdout.

Started (and killed on timeout) by solver.server. Not meant to be run by hand, except for debugging:
    echo {"op":"evaluate","args":{"expr":"2^10"}} | python -m solver.worker
"""
from __future__ import annotations

import json
import os
import sys

MAX_LINE_BYTES = 64 * 1024
WATCHDOG_SECONDS = float(os.environ.get("MATH_SOLVER_WATCHDOG_SECONDS", "10"))

_WARMUP = [
    ("equivalent", {"a": "(x+1)^2", "b": "x^2+2*x+1"}),
    ("equivalent", {"a": "sin(x)^2+cos(x)^2", "b": "1"}),
    ("equivalent", {"a": "2*x+3=7", "b": "x=2"}),
    ("equivalent", {"a": "x^2=4", "b": "x=2"}),
    ("check_steps", {"steps": ["2*(x+3)", "2*x+6"]}),
    ("numeric_check", {"expected": "sqrt(2)", "actual": 1.4142, "tolerance": 0.001, "units": {"expected": "m", "actual": "cm"}}),
    ("evaluate", {"expr": "log(x, 2) + exp(y) + factorial(5) + abs(-pi) + root(8, 3)", "substitutions": {"x": 8, "y": "0.5"}}),
    ("convert_units", {"value": 36, "from": "km/h", "to": "m/s"}),
]


def main() -> None:
    proto_out = sys.stdout.buffer
    sys.stdout = sys.stderr  # anything a library prints must not corrupt the protocol stream

    from . import sandbox
    sandbox.apply_os_limits()

    from . import ops  # imports SymPy (slow), before the audit hook

    for op, args in _WARMUP:  # pull in SymPy's lazily imported modules before locking down
        ops.run(op, args)

    sandbox.install_audit_hook()
    guard = sandbox.CpuGuard(WATCHDOG_SECONDS)
    info = {k: v for k, v in sandbox.applied.items() if not k.startswith("_")}
    proto_out.write(json.dumps({"ready": True, "sandbox": info}).encode() + b"\n")
    proto_out.flush()

    stdin = sys.stdin.buffer
    while True:
        line = stdin.readline(MAX_LINE_BYTES + 1)
        if not line:
            return  # parent closed the pipe (or died): exit
        if len(line) > MAX_LINE_BYTES:
            res = ops._res("invalid", "request_too_large")
            while line and not line.endswith(b"\n"):
                line = stdin.readline(MAX_LINE_BYTES + 1)
        else:
            guard.start()
            try:
                req = json.loads(line)
                res = ops.run(req.get("op"), req.get("args")) if isinstance(req, dict) else ops._res("invalid", "invalid_input")
            except json.JSONDecodeError:
                res = ops._res("invalid", "invalid_json")
            except sandbox.SandboxViolation:
                res = ops._res("inconclusive", "sandbox_violation", "the computation attempted a blocked operation")
            except Exception:  # noqa: BLE001 - never crash on a request; never report success
                res = ops._res("inconclusive", "internal_error", "the solver failed on this input")
            finally:
                guard.stop()
        proto_out.write(json.dumps(res, separators=(",", ":"), sort_keys=True).encode() + b"\n")
        proto_out.flush()


if __name__ == "__main__":
    main()
