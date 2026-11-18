# math-solver — deterministic maths sidecar (PD-07, F8)

## Purpose
Deterministic verification of maths for the tutor and the eval harness: symbolic/numeric equivalence,
step-by-step working checks, numeric answers with tolerance and units, exact evaluation. SymPy behind a
narrow JSON API. Reached only through `@platform/math-client`; never imported.

## Dependencies
Python 3.12+, `sympy==1.13.3`, `mpmath==1.3.0` (hash-pinned in `requirements.txt`, pure-Python
wheels). Standard library only for the HTTP server. No web framework.

## Setup
```
python services/math-solver/setup_env.py        # any OS: creates services/math-solver/.venv
# or (Windows)  powershell -ExecutionPolicy Bypass -File services/math-solver/setup.ps1
```
Run locally (binds 127.0.0.1 only):
```
cd services/math-solver
.venv/Scripts/python -m solver.server --port 8765      # Linux/macOS: .venv/bin/python
```
Tests:
```
cd services/math-solver && .venv/Scripts/python -m unittest discover -s tests -t .
node --test packages/math-client/test/client.test.ts           # from the repo root
node packages/math-client/test/bench.ts [requests] [concurrency] [workers]
```

## API
`GET /health` and `POST /v1/<op>` with a JSON body (max 16 KiB). Every result has
`ok` (true only if the check passed / a value was computed), `verdict`
(`pass | fail | inconclusive | invalid | unverified`), `reason` (stable code) and optional `detail`.

| op | arguments | notes |
|---|---|---|
| `equivalent` | `a`, `b`, `assume?` (`complex`/`real`/`positive`), `requireSymbolic?` | expressions or equations (`lhs = rhs`). Numeric sampling first (fixed points → counterexample), then a symbolic proof; if only sampling agrees: `pass` with `method:"numeric"` (or `inconclusive` with `requireSymbolic`). Equations: constant-multiple or same real solution set. |
| `check_steps` | `steps[]` (2..30), `assume?`, `requireSymbolic?` | `firstBadStep` = 0-based index of the first step not following from the previous one |
| `numeric_check` | `expected`, `actual` (number or constant expression), `tolerance?` (1e-9), `relative?`, `units?` (string or `{expected, actual}`) | exact rational arithmetic; `dimension_mismatch` is a `fail` |
| `evaluate` | `expr`, `substitutions?`, `precision?` (1..100 significant digits) | `unbound_symbols`, `undefined_expression` (e.g. division by zero) |
| `convert_units` | `value`, `from`, `to`, `precision?` | whitelisted `sympy.physics.units` only (see `solver/units.py`) |

Timeout, busy or crash → HTTP 504/503 with `verdict: "unverified"`. The TS client also returns
`unverified` when the service is unreachable or slow — never `ok`.

## Safety model
1. **No code execution.** Input is parsed with `ast.parse(mode="eval")` and walked against a whitelist
   (numbers, names, `+ - * / ** ^`, unary ±, calls to whitelisted maths functions). SymPy objects are
   constructed directly; `sympify` / `parse_expr` / `eval` are never used. Limits: 500 chars, 300 AST
   nodes, depth 40, 30-digit integers, exponent ≤ 1000, exact results ≤ 20 000 bits, factorial ≤ 1000.
2. **Wall-clock kill.** Requests run in pre-started worker processes (SymPy import is ~1 s, so no
   process-per-request); a worker that misses the 2 s deadline is killed and replaced.
3. **OS limits and tripwires** in each worker (`solver/sandbox.py`):

| layer | Linux / container | Windows (dev) |
|---|---|---|
| wall-clock kill (server) | yes | yes |
| per-request CPU cap | `RLIMIT_CPU` soft limit, 2 s | no — wall-clock only |
| self-watchdog (`os._exit`) | 10 s | 10 s |
| memory | `RLIMIT_AS` 768 MiB | Job Object `ProcessMemoryLimit` 768 MiB |
| child processes | `RLIMIT_NPROC=0` + audit hook | Job `ActiveProcessLimit=1` + audit hook |
| file writes | `RLIMIT_FSIZE=0` + audit hook | audit hook |
| file reads | audit hook: Python install + service dir only | same |
| network | audit hook + **no-network container** | audit hook only |

Audit hooks (PEP 578) are a tripwire, not a security boundary. On Windows there is no OS-level
network or filesystem isolation: treat local Windows runs as development only. Production runs the
`Dockerfile` (untested here — Docker unavailable) on an internal-only network with a read-only root
filesystem, non-root user, dropped capabilities and pids/memory/CPU limits (see the Dockerfile header).

## Removal
Delete `services/math-solver/` and `packages/math-client/`; remove `math-client` from the layer
table in `tooling/check-boundaries.ts` and any injected `MathChecker`. Consumers then get no checker
and must treat maths as unverified.
