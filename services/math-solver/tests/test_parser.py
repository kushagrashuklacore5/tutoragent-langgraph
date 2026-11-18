"""Whitelist parser: malicious and oversized inputs are rejected before any SymPy work."""
import time
import unittest

import sympy as sp

from solver.safe_parse import MAX_LENGTH, ParseError, parse, parse_equation_or_expr

x, y = sp.symbols("x y")


class AcceptsMaths(unittest.TestCase):
    def test_basic_arithmetic_and_power_caret(self):
        self.assertEqual(parse("x^2 + 2*x + 1"), x**2 + 2 * x + 1)
        self.assertEqual(parse("2**10"), 1024)
        self.assertEqual(parse("-(x - y)"), y - x)

    def test_decimals_are_exact(self):
        self.assertEqual(parse("0.1"), sp.Rational(1, 10))
        self.assertEqual(parse("1.5e3"), 1500)

    def test_functions_and_constants(self):
        self.assertEqual(parse("sin(pi/2)"), 1)
        self.assertEqual(parse("log(8, 2)"), 3)
        self.assertEqual(parse("sqrt(16) + abs(-3) + factorial(4)"), 31)
        self.assertEqual(parse("e"), sp.E)
        self.assertEqual(parse("π"), sp.pi)

    def test_unicode_operators(self):
        self.assertEqual(parse("6 ÷ 3 × 2 − 1"), 3)

    def test_equations(self):
        lhs, rhs = parse_equation_or_expr("2*x + 3 = 7")
        self.assertEqual((lhs, rhs), (2 * x + 3, 7))


class RejectsCode(unittest.TestCase):
    def rejects(self, text, code=None):
        with self.assertRaises(ParseError) as cm:
            parse(text)
        if code:
            self.assertEqual(cm.exception.code, code, text)
        return cm.exception

    def test_import_and_builtins(self):
        for t in ["__import__('os')", "__import__(os)", "eval(1)", "exec(x)", "open(x)", "globals()",
                  "getattr(x, y)", "type(x)", "print(1)", "sympify(x)", "Symbol(x)"]:
            self.rejects(t)

    def test_attribute_subscript_lambda_comprehension(self):
        for t in ["x.__class__", "().__class__.__bases__", "x[0]", "(lambda: 1)()", "[i for i in x]",
                  "{1: 2}", "x if y else 1", "(x := 1)", "x == y", "x and y", "not x", "*x", "f'{x}'",
                  "b'abc'", "1j", "True", "None", "...", "x @ y", "x % y", "x // y", "x << 2", "~x"]:
            self.rejects(t)

    def test_dunder_and_reserved_names(self):
        for t in ["__x", "_x", "x__y", "I", "oo", "zoo", "nan", "os", "sys"]:
            self.rejects(t)

    def test_keyword_and_starred_args(self):
        self.rejects("sin(x=1)")
        self.rejects("log(*x)")
        self.rejects("sin(1, 2)", "wrong_arity")

    def test_function_name_without_call(self):
        self.rejects("sin + 1")


class EnforcesLimits(unittest.TestCase):
    def fast_reject(self, text, code="limit_exceeded"):
        t0 = time.monotonic()
        with self.assertRaises(ParseError) as cm:
            parse(text)
        self.assertEqual(cm.exception.code, code, text)
        self.assertLess(time.monotonic() - t0, 0.5, f"rejecting {text[:40]} took too long")

    def test_tower_of_powers(self):
        self.fast_reject("9**9**9")
        self.fast_reject("9^9^9")
        self.fast_reject("(2^1000)^1000")
        self.fast_reject("2^100000")
        self.fast_reject("10^(10^10)")

    def test_huge_literals(self):
        self.fast_reject("1" * 40)
        self.fast_reject("1e999")
        self.fast_reject("1e400")

    def test_long_input(self):
        self.fast_reject("x+" * (MAX_LENGTH // 2 + 1) + "x")

    def test_deep_nesting(self):
        self.fast_reject("(" * 120 + "x" + ")" * 120 + "+" + "-" * 100 + "x")
        self.fast_reject("sin(" * 60 + "x" + ")" * 60)

    def test_many_nodes(self):
        self.fast_reject("+".join(["x"] * 240))

    def test_factorial_bound(self):
        self.fast_reject("factorial(100000)")
        self.assertEqual(parse("factorial(x)"), sp.factorial(x))

    def test_product_growth(self):
        self.fast_reject("(10^30)^600 * (10^30)^600")


if __name__ == "__main__":
    unittest.main()
