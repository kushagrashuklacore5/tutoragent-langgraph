"""The solver operations. Pure functions: JSON-compatible dict in, JSON-compatible dict out.

Every result carries
  ok       true only when the check passed (or, for evaluate/convert_units, a value was computed)
  verdict  'pass' | 'fail' | 'inconclusive' | 'invalid'
  reason   stable machine-readable code explaining the verdict
  detail   optional human-readable explanation
Callers must treat anything other than ok=true as "not verified".
"""
from __future__ import annotations

import math
import re
from typing import Any, Callable

import sympy as sp

from .safe_parse import ParseError, parse, parse_equation_or_expr
from .units import UnitError, conversion_factor, dimension_of, format_dimension, parse_unit

MAX_STEPS = 30
MAX_SUBSTITUTIONS = 20
DEFAULT_PRECISION = 15
MAX_PRECISION = 100
NUMERIC_SAMPLES = 8
MIN_VALID_SAMPLES = 3
SAMPLE_REL_TOL = 1e-9
_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,15}$")

# Fixed, deliberately "awkward" sample points (avoid 0, 1, integers and simple fractions so that
# removable singularities like x/x or (x^2-1)/(x-1) are not hit). Deterministic by construction.
_SAMPLES = [sp.Rational(n, 1000) for n in (371, -1234, 2718, 613, -297, 1732, -2411, 3141, 829, -673, 1414, -1999)]


class InvalidArgs(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _res(verdict: str, reason: str, detail: str | None = None, **extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": verdict == "pass", "verdict": verdict, "reason": reason}
    if detail:
        out["detail"] = detail
    out.update(extra)
    return out


def _undefined(e: sp.Expr) -> bool:
    return bool(e.has(sp.zoo, sp.nan, sp.oo, -sp.oo))


def _fmt(e: sp.Expr, digits: int = DEFAULT_PRECISION) -> str:
    return str(sp.N(e, digits))


def _exact(e: sp.Expr) -> str | None:
    s = sp.sstr(e)
    return s if len(s) <= 200 else None


def _arg_str(args: dict[str, Any], key: str) -> str:
    v = args.get(key)
    if not isinstance(v, str):
        raise InvalidArgs("invalid_input", f"'{key}' must be a string")
    return v


def _arg_quantity(args: dict[str, Any], key: str) -> sp.Expr:
    """A number or a constant expression string (no free symbols)."""
    v = args.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        raise InvalidArgs("invalid_input", f"'{key}' must be a number or an expression string")
    if isinstance(v, float) and not math.isfinite(v):
        raise InvalidArgs("invalid_input", f"'{key}' must be finite")
    e = parse(v if isinstance(v, str) else repr(v))
    if e.free_symbols:
        raise InvalidArgs("unbound_symbols", f"'{key}' must not contain variables")
    return e


def _precision(args: dict[str, Any]) -> int:
    p = args.get("precision", DEFAULT_PRECISION)
    if isinstance(p, bool) or not isinstance(p, int) or not 1 <= p <= MAX_PRECISION:
        raise InvalidArgs("invalid_input", f"'precision' must be an integer in 1..{MAX_PRECISION}")
    return p


def _flag(args: dict[str, Any], key: str) -> bool:
    v = args.get(key, False)
    if not isinstance(v, bool):
        raise InvalidArgs("invalid_input", f"'{key}' must be a boolean")
    return v


# ---------------------------------------------------------------- equivalence core

def _to_complex(v: sp.Expr) -> complex | None:
    if not v.is_number or _undefined(v):
        return None
    try:
        c = complex(v)
    except (TypeError, ValueError, OverflowError):
        return None
    if not (math.isfinite(c.real) and math.isfinite(c.imag)):
        return None
    return c


def _sample_compare(a: sp.Expr, b: sp.Expr) -> tuple[int, dict[str, Any] | None]:
    """Evaluate a and b at fixed points. Returns (#valid points, first counterexample or None)."""
    syms = sorted(a.free_symbols | b.free_symbols, key=lambda s: s.name)
    n_points = NUMERIC_SAMPLES if syms else 1
    valid = 0
    for j in range(n_points):
        point = {s: _SAMPLES[(j + 5 * k) % len(_SAMPLES)] for k, s in enumerate(syms)}
        point = {s: (abs(v) if s.is_positive else v) for s, v in point.items()}
        ca = _to_complex(a.evalf(30, subs=point))
        cb = _to_complex(b.evalf(30, subs=point))
        if ca is None or cb is None:
            continue  # undefined at this point (singularity / overflow): skip it
        valid += 1
        if abs(ca - cb) > SAMPLE_REL_TOL * max(1.0, abs(ca), abs(cb)):
            return valid, {
                "at": {s.name: str(v) for s, v in point.items()},
                "a": _fmt(a.evalf(30, subs=point)),
                "b": _fmt(b.evalf(30, subs=point)),
            }
    return valid, None


def _symbolic_zero(diff: sp.Expr) -> bool:
    if diff == 0:
        return True
    if sp.expand(diff) == 0:
        return True
    return sp.simplify(diff) == 0


def _expr_equiv(a: sp.Expr, b: sp.Expr, require_symbolic: bool) -> dict[str, Any]:
    for side, e in (("a", a), ("b", b)):
        if _undefined(e):
            return _res("fail", "undefined_expression", f"expression {side} is undefined (e.g. division by zero)", side=side)
    if a == b:
        return _res("pass", "equivalent", method="symbolic")
    valid, counter = _sample_compare(a, b)
    if counter is not None:
        return _res("fail", "not_equivalent", "expressions differ at a sample point", method="numeric", counterexample=counter)
    if _symbolic_zero(a - b):
        return _res("pass", "equivalent", method="symbolic")
    if valid < (1 if not (a.free_symbols | b.free_symbols) else MIN_VALID_SAMPLES):
        return _res("inconclusive", "insufficient_samples", "symbolic check inconclusive and too few points were defined", method="numeric")
    if require_symbolic:
        return _res("inconclusive", "symbolic_inconclusive", f"no symbolic proof; {valid} numeric samples agree", method="numeric", samples=valid)
    return _res("pass", "equivalent_numerically",
                f"symbolic simplification was inconclusive; {valid} deterministic numeric samples agree",
                method="numeric", samples=valid)


def _equation_equiv(d1: sp.Expr, d2: sp.Expr) -> dict[str, Any]:
    """Two equations d1 = 0 and d2 = 0: same solution set?"""
    for e in (d1, d2):
        if _undefined(e):
            return _res("fail", "undefined_expression", "equation is undefined (e.g. division by zero)")
    if d1 == 0 or d2 == 0:
        same = (sp.simplify(d1) == 0) == (sp.simplify(d2) == 0)
        return _res("pass" if same else "fail", "equivalent" if same else "not_equivalent", method="symbolic")
    ratio = sp.simplify(d2 / d1)
    if ratio.is_number and ratio != 0 and not _undefined(ratio):
        return _res("pass", "equivalent", "equations differ by a non-zero constant factor", method="symbolic")
    syms = d1.free_symbols | d2.free_symbols
    if len(syms) == 1:
        x = next(iter(syms))
        s1 = sp.solveset(d1, x, sp.S.Reals)
        s2 = sp.solveset(d2, x, sp.S.Reals)
        if not isinstance(s1, sp.ConditionSet) and not isinstance(s2, sp.ConditionSet):
            if s1 == s2:
                return _res("pass", "equivalent", "equations have the same real solution set", method="solution_set")
            return _res("fail", "not_equivalent", f"real solution sets differ: {sp.sstr(s1)} vs {sp.sstr(s2)}", method="solution_set")
    return _res("inconclusive", "symbolic_inconclusive", "could not decide whether the equations are equivalent", method="symbolic")


ASSUMPTIONS = {"complex": {}, "real": {"real": True}, "positive": {"positive": True}}


def _assumption(args: dict[str, Any]) -> dict[str, bool]:
    a = args.get("assume", "complex")
    if a not in ASSUMPTIONS:
        raise InvalidArgs("invalid_input", "'assume' must be 'complex', 'real' or 'positive'")
    return ASSUMPTIONS[a]


def _with_assumptions(p: tuple[sp.Expr, sp.Expr | None], assume: dict[str, bool]) -> tuple[sp.Expr, sp.Expr | None]:
    if not assume:
        return p
    syms = set().union(*(e.free_symbols for e in p if e is not None))
    m = {s: sp.Symbol(s.name, **assume) for s in syms if isinstance(s, sp.Symbol)}
    return p[0].xreplace(m), (p[1].xreplace(m) if p[1] is not None else None)


def _parsed_equiv(p1: tuple[sp.Expr, sp.Expr | None], p2: tuple[sp.Expr, sp.Expr | None], require_symbolic: bool,
                  assume: dict[str, bool] | None = None) -> dict[str, Any]:
    if assume:
        p1, p2 = _with_assumptions(p1, assume), _with_assumptions(p2, assume)
    (l1, r1), (l2, r2) = p1, p2
    if (r1 is None) != (r2 is None):
        return _res("fail", "mixed_kinds", "cannot compare an equation with an expression")
    if r1 is None or r2 is None:
        return _expr_equiv(l1, l2, require_symbolic)
    return _equation_equiv(l1 - r1, l2 - r2)


# ---------------------------------------------------------------- operations

def op_equivalent(args: dict[str, Any]) -> dict[str, Any]:
    a = parse_equation_or_expr(_arg_str(args, "a"))
    b = parse_equation_or_expr(_arg_str(args, "b"))
    return _parsed_equiv(a, b, _flag(args, "requireSymbolic"), _assumption(args))


def op_check_steps(args: dict[str, Any]) -> dict[str, Any]:
    steps = args.get("steps")
    if not isinstance(steps, list) or not 2 <= len(steps) <= MAX_STEPS or not all(isinstance(s, str) for s in steps):
        raise InvalidArgs("invalid_input", f"'steps' must be a list of 2..{MAX_STEPS} strings")
    require_symbolic = _flag(args, "requireSymbolic")
    assume = _assumption(args)
    parsed = []
    for i, s in enumerate(steps):
        try:
            parsed.append(parse_equation_or_expr(s))
        except ParseError as e:
            return _res("invalid", e.code, f"step {i}: {e.message}", step=i)
    results = []
    first_inconclusive = None
    for i in range(1, len(parsed)):
        r = _parsed_equiv(parsed[i - 1], parsed[i], require_symbolic, assume)
        results.append({"step": i, "verdict": r["verdict"], "reason": r["reason"], **({"method": r["method"]} if "method" in r else {})})
        if r["verdict"] == "fail":
            return _res("fail", r["reason"], f"step {i} does not follow from step {i - 1}" + (f": {r['detail']}" if r.get("detail") else ""),
                        firstBadStep=i, steps=results, **({"counterexample": r["counterexample"]} if "counterexample" in r else {}))
        if r["verdict"] == "inconclusive" and first_inconclusive is None:
            first_inconclusive = i
    if first_inconclusive is not None:
        return _res("inconclusive", "step_inconclusive", f"step {first_inconclusive} could not be verified",
                    firstInconclusiveStep=first_inconclusive, steps=results)
    return _res("pass", "all_steps_valid", steps=results)


def _units_arg(args: dict[str, Any]) -> tuple[str | None, str | None]:
    u = args.get("units")
    if u is None:
        return None, None
    if isinstance(u, str):
        return u, u
    if isinstance(u, dict) and isinstance(u.get("expected"), str) and isinstance(u.get("actual"), str):
        return u["expected"], u["actual"]
    raise InvalidArgs("invalid_input", "'units' must be a string or {expected: string, actual: string}")


def op_numeric_check(args: dict[str, Any]) -> dict[str, Any]:
    expected = _arg_quantity(args, "expected")
    actual = _arg_quantity(args, "actual")
    tol_raw = args.get("tolerance", 1e-9)
    if isinstance(tol_raw, bool) or not isinstance(tol_raw, (int, float)) or not math.isfinite(tol_raw) or tol_raw < 0:
        raise InvalidArgs("invalid_input", "'tolerance' must be a finite number >= 0")
    tolerance = sp.Rational(repr(tol_raw)) if isinstance(tol_raw, float) else sp.Integer(tol_raw)
    relative = _flag(args, "relative")
    exp_unit, act_unit = _units_arg(args)
    extra: dict[str, Any] = {}
    if exp_unit is not None and act_unit is not None:
        try:
            factor = conversion_factor(parse_unit(act_unit), parse_unit(exp_unit))
        except UnitError as e:
            verdict = "fail" if e.code == "dimension_mismatch" else "invalid"
            return _res(verdict, e.code, e.message)
        actual = actual * factor
        extra["unit"] = exp_unit
        extra["dimension"] = format_dimension(dimension_of(parse_unit(exp_unit)))
    for name, e in (("expected", expected), ("actual", actual)):
        if _undefined(e):
            return _res("invalid", "undefined_expression", f"{name} value is undefined")
    diff = sp.Abs(sp.N(actual - expected, 50))
    if not diff.is_real:
        return _res("invalid", "not_real", "values must be real numbers")
    bound = tolerance * sp.Abs(sp.N(expected, 50)) if relative else tolerance
    if relative and expected == 0:
        bound = tolerance  # relative tolerance around zero falls back to absolute
        extra["note"] = "expected is 0; relative tolerance applied as absolute"
    within = bool(diff <= bound)
    return _res("pass" if within else "fail", "within_tolerance" if within else "outside_tolerance",
                expectedValue=_fmt(expected), actualValue=_fmt(actual), difference=_fmt(diff, 6),
                tolerance=_fmt(bound, 6), relative=relative, **extra)


def op_evaluate(args: dict[str, Any]) -> dict[str, Any]:
    expr = parse(_arg_str(args, "expr"))
    precision = _precision(args)
    subs_raw = args.get("substitutions", {})
    if not isinstance(subs_raw, dict) or len(subs_raw) > MAX_SUBSTITUTIONS:
        raise InvalidArgs("invalid_input", f"'substitutions' must be an object with at most {MAX_SUBSTITUTIONS} entries")
    subs: dict[sp.Symbol, sp.Expr] = {}
    for name, value in sorted(subs_raw.items()):
        if not isinstance(name, str) or not _NAME_RE.match(name):
            raise InvalidArgs("invalid_input", f"invalid variable name '{name}'")
        subs[sp.Symbol(name)] = _arg_quantity(subs_raw, name)
    result = expr.xreplace(subs) if subs else expr
    if _undefined(result):
        return _res("fail", "undefined_expression", "expression is undefined for these values (e.g. division by zero)")
    unbound = sorted(s.name for s in result.free_symbols)
    if unbound:
        return _res("fail", "unbound_symbols", f"no value given for: {', '.join(unbound)}", symbols=unbound)
    value = sp.N(result, precision)
    if _undefined(value):
        return _res("fail", "undefined_expression", "expression is undefined for these values")
    return _res("pass", "evaluated", value=str(value), exact=_exact(result), isReal=bool(value.is_real), precision=precision)


def op_convert_units(args: dict[str, Any]) -> dict[str, Any]:
    value = _arg_quantity(args, "value")
    precision = _precision(args)
    try:
        factor = conversion_factor(parse_unit(_arg_str(args, "from")), parse_unit(_arg_str(args, "to")))
    except UnitError as e:
        return _res("fail" if e.code == "dimension_mismatch" else "invalid", e.code, e.message)
    result = value * factor
    return _res("pass", "converted", value=str(sp.N(result, precision)), exact=_exact(result), factor=_exact(factor), unit=args["to"])


OPERATIONS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "equivalent": op_equivalent,
    "check_steps": op_check_steps,
    "numeric_check": op_numeric_check,
    "evaluate": op_evaluate,
    "convert_units": op_convert_units,
}


def run(op: str, args: Any) -> dict[str, Any]:
    """Dispatch one request. Never raises for bad input; returns an 'invalid' verdict instead."""
    fn = OPERATIONS.get(op) if isinstance(op, str) else None
    if fn is None:
        return _res("invalid", "unknown_operation", "unknown operation")
    if not isinstance(args, dict):
        return _res("invalid", "invalid_input", "arguments must be an object")
    try:
        return fn(args)
    except ParseError as e:
        return _res("invalid", e.code, e.message)
    except InvalidArgs as e:
        return _res("invalid", e.code, e.message)
    except (RecursionError, MemoryError):
        return _res("inconclusive", "resource_limit", "the computation exceeded a resource limit")
    except (ZeroDivisionError, ValueError, TypeError, ArithmeticError, NotImplementedError, AttributeError):
        # SymPy raised while working on a well-formed, whitelisted expression.
        return _res("inconclusive", "computation_error", "the expression could not be processed")
