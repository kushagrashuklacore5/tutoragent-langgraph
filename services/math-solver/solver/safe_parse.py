"""Whitelist parser: untrusted text -> SymPy expression, without ever evaluating Python.

The input is parsed with ``ast.parse(mode='eval')`` (which only builds a syntax tree, it never
executes anything) and the tree is walked against an explicit whitelist. SymPy objects are built
by this module directly; ``sympify``, ``parse_expr``, ``eval`` and ``exec`` are never used on
user text. Anything not on the whitelist (attributes, subscripts, strings, lambdas, comprehensions,
keyword arguments, starred arguments, comparisons, boolean operators, ...) is rejected.

Resource limits applied while parsing (before any SymPy work):
  * input length, AST node count and nesting depth
  * integer literal size, float literal exponent
  * exponent size and the estimated bit length of exact numeric powers (blocks ``9**9**9``)
  * factorial argument size
"""
from __future__ import annotations

import ast
import math
import re
from fractions import Fraction
from typing import Callable, Mapping

import sympy as sp

MAX_LENGTH = 500
MAX_NODES = 300
MAX_DEPTH = 40
MAX_INT_DIGITS = 30
MAX_FLOAT_EXPONENT = 300
MAX_POWER_EXPONENT = 1000
MAX_RESULT_BITS = 20_000
MAX_FACTORIAL = 1000

_NAME_RE = re.compile(r"^[A-Za-zͰ-Ͽ](?:[A-Za-z0-9Ͱ-Ͽ]|_(?=[A-Za-z0-9]))*$")
MAX_NAME_LENGTH = 16


class ParseError(ValueError):
    """Input rejected. ``code`` is a stable machine-readable reason."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _log(*args: sp.Expr) -> sp.Expr:
    if len(args) == 1:
        return sp.log(args[0])
    return sp.log(args[0], args[1])  # log(x, base)


def _root(x: sp.Expr, n: sp.Expr) -> sp.Expr:
    return sp.root(x, n)


def _factorial(n: sp.Expr) -> sp.Expr:
    if n.is_Number and (not n.is_integer or n < 0 or n > MAX_FACTORIAL):
        raise ParseError("limit_exceeded", f"factorial argument must be an integer in 0..{MAX_FACTORIAL}")
    return sp.factorial(n)


# name -> (callable, allowed argument counts)
FUNCTIONS: dict[str, tuple[Callable[..., sp.Expr], tuple[int, ...]]] = {
    "sin": (sp.sin, (1,)), "cos": (sp.cos, (1,)), "tan": (sp.tan, (1,)),
    "cot": (sp.cot, (1,)), "sec": (sp.sec, (1,)), "csc": (sp.csc, (1,)),
    "asin": (sp.asin, (1,)), "acos": (sp.acos, (1,)), "atan": (sp.atan, (1,)),
    "arcsin": (sp.asin, (1,)), "arccos": (sp.acos, (1,)), "arctan": (sp.atan, (1,)),
    "sinh": (sp.sinh, (1,)), "cosh": (sp.cosh, (1,)), "tanh": (sp.tanh, (1,)),
    "exp": (sp.exp, (1,)), "log": (_log, (1, 2)), "ln": (sp.log, (1,)),
    "sqrt": (sp.sqrt, (1,)), "root": (_root, (2,)), "cbrt": (sp.cbrt, (1,)),
    "abs": (sp.Abs, (1,)), "Abs": (sp.Abs, (1,)),
    "factorial": (_factorial, (1,)),
}

CONSTANTS: dict[str, sp.Expr] = {"pi": sp.pi, "π": sp.pi, "E": sp.E, "e": sp.E}

# Words that are never symbols (they look like Python/SymPy internals or are ambiguous).
RESERVED = frozenset({"I", "oo", "nan", "zoo", "inf", "infinity", "None", "True", "False", "lambda",
                      "import", "eval", "exec", "open", "print", "os", "sys", "S", "N", "Q", "O"})

_ALLOWED_BINOPS = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)


def _bits(n: sp.Expr) -> float:
    """log2 of the size of an exact rational (numerator + denominator)."""
    if n.is_Integer:
        return float(abs(int(n)).bit_length())
    if n.is_Rational:
        return float(abs(int(n.p)).bit_length() + int(n.q).bit_length())
    return 0.0


def _check_size(v: sp.Expr) -> sp.Expr:
    if v.is_Rational and _bits(v) > MAX_RESULT_BITS:
        raise ParseError("limit_exceeded", "intermediate number is too large")
    return v


def _number(node: ast.Constant, source: str) -> sp.Expr:
    value = node.value
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ParseError("disallowed_syntax", "only numeric literals are allowed")
    if isinstance(value, int):
        if len(str(abs(value))) > MAX_INT_DIGITS:
            raise ParseError("limit_exceeded", f"integer literals are limited to {MAX_INT_DIGITS} digits")
        return sp.Integer(value)
    if not math.isfinite(value):
        raise ParseError("limit_exceeded", "number is out of range")
    text = (ast.get_source_segment(source, node) or repr(value)).replace("_", "")
    m = re.search(r"[eE]([+-]?\d+)$", text)
    if m and abs(int(m.group(1))) > MAX_FLOAT_EXPONENT:
        raise ParseError("limit_exceeded", "number is out of range")
    try:
        frac = Fraction(text)  # exact decimal value, so 0.1 means 1/10
    except (ValueError, ZeroDivisionError):
        frac = Fraction(value)
    return sp.Rational(frac.numerator, frac.denominator)


class _Builder:
    def __init__(self, source: str, symbols: Mapping[str, sp.Expr] | None, allow_any_symbol: bool) -> None:
        self.source = source
        self.symbols = symbols or {}
        self.allow_any_symbol = allow_any_symbol
        self.nodes = 0

    def build(self, node: ast.AST, depth: int = 0) -> sp.Expr:
        self.nodes += 1
        if self.nodes > MAX_NODES:
            raise ParseError("limit_exceeded", f"expression has more than {MAX_NODES} parts")
        if depth > MAX_DEPTH:
            raise ParseError("limit_exceeded", "expression is nested too deeply")

        if isinstance(node, ast.Constant):
            return _number(node, self.source)

        if isinstance(node, ast.Name):
            return self.name(node.id)

        if isinstance(node, ast.UnaryOp):
            operand = self.build(node.operand, depth + 1)
            if isinstance(node.op, ast.USub):
                return -operand
            if isinstance(node.op, ast.UAdd):
                return operand
            raise ParseError("disallowed_syntax", "operator not allowed")

        if isinstance(node, ast.BinOp):
            if not isinstance(node.op, _ALLOWED_BINOPS):
                raise ParseError("disallowed_syntax", "operator not allowed")
            left = self.build(node.left, depth + 1)
            right = self.build(node.right, depth + 1)
            if isinstance(node.op, ast.Add):
                return _check_size(left + right)
            if isinstance(node.op, ast.Sub):
                return _check_size(left - right)
            if isinstance(node.op, ast.Mult):
                return _check_size(left * right)
            if isinstance(node.op, ast.Div):
                return _check_size(left / right)
            return self.power(left, right)

        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in FUNCTIONS:
                raise ParseError("disallowed_function", "function not allowed")
            if node.keywords or any(isinstance(a, ast.Starred) for a in node.args):
                raise ParseError("disallowed_syntax", "keyword or starred arguments are not allowed")
            fn, arities = FUNCTIONS[node.func.id]
            if len(node.args) not in arities:
                raise ParseError("wrong_arity", f"{node.func.id} takes {' or '.join(map(str, arities))} argument(s)")
            args = [self.build(a, depth + 1) for a in node.args]
            return fn(*args)

        raise ParseError("disallowed_syntax", f"{type(node).__name__} is not allowed")

    def name(self, ident: str) -> sp.Expr:
        if ident in self.symbols:
            return self.symbols[ident]
        if ident in CONSTANTS:
            return CONSTANTS[ident]
        if ident in FUNCTIONS:
            raise ParseError("disallowed_syntax", f"{ident} must be called with arguments")
        if not self.allow_any_symbol:
            raise ParseError("unknown_name", f"unknown name '{ident}'")
        if ident in RESERVED or len(ident) > MAX_NAME_LENGTH or not _NAME_RE.match(ident):
            raise ParseError("disallowed_name", f"name '{ident}' is not allowed")
        return sp.Symbol(ident)

    def power(self, base: sp.Expr, exp: sp.Expr) -> sp.Expr:
        if exp.is_Number:
            if abs(exp) > MAX_POWER_EXPONENT:
                raise ParseError("limit_exceeded", f"exponents are limited to {MAX_POWER_EXPONENT}")
            if base.is_Rational and exp.is_Rational and _bits(base) * abs(float(exp)) > MAX_RESULT_BITS:
                raise ParseError("limit_exceeded", "power result is too large")
        return _check_size(sp.Pow(base, exp))


def _preprocess(text: str) -> str:
    if not isinstance(text, str):
        raise ParseError("invalid_input", "expression must be a string")
    if len(text) > MAX_LENGTH:
        raise ParseError("limit_exceeded", f"expression is longer than {MAX_LENGTH} characters")
    if not text.strip():
        raise ParseError("invalid_input", "expression is empty")
    # Characters that can only appear in disallowed syntax are rejected before parsing.
    if any(c in text for c in "'\"`;:\\[]{}@$#&|~<>!=\n\r\t\x00"):
        raise ParseError("disallowed_syntax", "expression contains disallowed characters")
    # Maths notation: '^' is power, '×' and '÷' are times/divide, '−' is minus.
    # This is a plain text substitution; the result still goes through the whitelist walker.
    return (text.replace("^", "**").replace("×", "*").replace("÷", "/")
            .replace("−", "-").replace("·", "*"))


def parse(text: str, symbols: Mapping[str, sp.Expr] | None = None, allow_any_symbol: bool = True) -> sp.Expr:
    """Parse untrusted maths text. Raises ParseError on anything outside the whitelist."""
    src = _preprocess(text)
    try:
        tree = ast.parse(src.strip(), mode="eval")
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        raise ParseError("syntax_error", "expression could not be parsed") from None
    try:
        return _Builder(src.strip(), symbols, allow_any_symbol).build(tree.body)
    except RecursionError:
        raise ParseError("limit_exceeded", "expression is nested too deeply") from None


def parse_equation_or_expr(text: str) -> tuple[sp.Expr, sp.Expr | None]:
    """Parse ``lhs = rhs`` (single '=') or a plain expression. Returns (lhs, rhs or None)."""
    if not isinstance(text, str):
        raise ParseError("invalid_input", "expression must be a string")
    if text.count("=") == 0:
        return parse(text), None
    if text.count("=") != 1 or "==" in text:
        raise ParseError("syntax_error", "an equation must contain exactly one '='")
    lhs, rhs = text.split("=")
    return parse(lhs), parse(rhs)
