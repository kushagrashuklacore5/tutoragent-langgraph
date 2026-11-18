"""Operations: equivalence, steps, tolerance, precision, units, determinism."""
import json
import unittest

from solver.ops import run


def eq(a, b, **kw):
    return run("equivalent", {"a": a, "b": b, **kw})


class Equivalence(unittest.TestCase):
    def test_symbolic_identities(self):
        for a, b in [("(x+1)**2", "x**2+2*x+1"), ("sin(x)^2+cos(x)^2", "1"), ("tan(x)", "sin(x)/cos(x)"),
                     ("(x^2-1)/(x-1)", "x+1"), ("2^0.5", "sqrt(2)"), ("0.1+0.2", "0.3"), ("exp(log(x))", "x"),
                     ("x*y", "y*x"), ("2*(x+3)", "2*x+6")]:
            r = eq(a, b)
            self.assertTrue(r["ok"], (a, b, r))
            self.assertEqual(r["method"], "symbolic")

    def test_not_equivalent_with_counterexample(self):
        r = eq("(x+1)^2", "x^2+1")
        self.assertEqual((r["ok"], r["verdict"], r["reason"]), (False, "fail", "not_equivalent"))
        self.assertIn("x", r["counterexample"]["at"])

    def test_branch_cuts_need_assumptions(self):
        self.assertFalse(eq("sqrt(x^2)", "x")["ok"])
        self.assertTrue(eq("sqrt(x^2)", "x", assume="positive")["ok"])
        self.assertFalse(eq("log(x*y)", "log(x)+log(y)")["ok"])
        self.assertTrue(eq("log(x*y)", "log(x)+log(y)", assume="positive")["ok"])
        self.assertTrue(eq("sqrt(x^2)", "abs(x)", assume="real")["ok"])

    def test_division_by_zero_and_undefined(self):
        for a in ["1/0", "0/0", "log(0)"]:
            r = eq(a, "1")
            self.assertEqual((r["ok"], r["reason"]), (False, "undefined_expression"), a)
        self.assertEqual(eq("1/0", "1/0")["reason"], "undefined_expression")

    def test_numeric_fallback_is_reported(self):
        # gamma-function identity SymPy's simplify does not prove: numeric samples agree
        r = eq("factorial(x+1)", "(x+1)*factorial(x)")
        self.assertTrue(r["ok"], r)
        r2 = eq("factorial(x+1)/factorial(x)", "x+1", requireSymbolic=True)
        self.assertIn(r2["verdict"], ("pass", "inconclusive"))
        if r2["verdict"] == "pass":
            self.assertEqual(r2["method"], "symbolic")

    def test_constant_expressions(self):
        self.assertTrue(eq("sqrt(2)*sqrt(3)", "sqrt(6)")["ok"])
        self.assertFalse(eq("pi", "3.14159")["ok"])

    def test_equations(self):
        self.assertTrue(eq("2*x+3=7", "x=2")["ok"])
        self.assertTrue(eq("2*x+3=7", "4*x+6=14")["ok"])
        r = eq("x^2=4", "x=2")
        self.assertEqual((r["ok"], r["method"]), (False, "solution_set"))
        self.assertEqual(eq("x=1", "x+1")["reason"], "mixed_kinds")

    def test_invalid_input_is_not_ok(self):
        for bad in [{"a": "__import__('os')", "b": "1"}, {"a": 1, "b": "1"}, {"a": "x"}, {"a": "x", "b": "x", "assume": "weird"}]:
            r = run("equivalent", bad)
            self.assertEqual((r["ok"], r["verdict"]), (False, "invalid"), bad)
        self.assertEqual(run("nope", {})["reason"], "unknown_operation")
        self.assertEqual(run("equivalent", [])["reason"], "invalid_input")


class Steps(unittest.TestCase):
    def test_all_valid(self):
        r = run("check_steps", {"steps": ["(x+2)*(x-2)", "x^2-2*x+2*x-4", "x^2-4"]})
        self.assertEqual((r["ok"], r["reason"]), (True, "all_steps_valid"))

    def test_first_bad_step_reported(self):
        r = run("check_steps", {"steps": ["(x+1)^2", "x^2+2*x+1", "x^2+3*x+1", "x^2+3*x+1"]})
        self.assertEqual((r["ok"], r["reason"], r["firstBadStep"]), (False, "not_equivalent", 2))

    def test_equation_solving_steps(self):
        ok = run("check_steps", {"steps": ["3*x - 5 = 10", "3*x = 15", "x = 5"]})
        self.assertTrue(ok["ok"], ok)
        bad = run("check_steps", {"steps": ["3*x - 5 = 10", "3*x = 5", "x = 5/3"]})
        self.assertEqual((bad["ok"], bad["firstBadStep"]), (False, 1))

    def test_parse_error_names_the_step(self):
        r = run("check_steps", {"steps": ["x+1", "x.__class__"]})
        self.assertEqual((r["verdict"], r["step"]), ("invalid", 1))

    def test_step_count_limits(self):
        self.assertEqual(run("check_steps", {"steps": ["x"]})["verdict"], "invalid")
        self.assertEqual(run("check_steps", {"steps": ["x"] * 31})["verdict"], "invalid")


class NumericCheck(unittest.TestCase):
    def nc(self, **kw):
        return run("numeric_check", kw)

    def test_absolute_tolerance(self):
        self.assertTrue(self.nc(expected="sqrt(2)", actual=1.4142, tolerance=1e-4)["ok"])
        r = self.nc(expected="sqrt(2)", actual=1.41, tolerance=1e-3)
        self.assertEqual((r["ok"], r["reason"]), (False, "outside_tolerance"))

    def test_relative_tolerance(self):
        self.assertTrue(self.nc(expected=1000, actual=1009, tolerance=0.01, relative=True)["ok"])
        self.assertFalse(self.nc(expected=1000, actual=1011, tolerance=0.01, relative=True)["ok"])
        self.assertFalse(self.nc(expected=1, actual=1.011, tolerance=0.01, relative=True)["ok"])

    def test_relative_tolerance_at_zero_falls_back_to_absolute(self):
        r = self.nc(expected=0, actual=0.001, tolerance=0.01, relative=True)
        self.assertTrue(r["ok"])
        self.assertIn("note", r)

    def test_exact_decimal_comparison(self):
        self.assertTrue(self.nc(expected="0.3", actual="0.1+0.2", tolerance=0)["ok"])

    def test_units_conversion(self):
        r = self.nc(expected=1.5, actual=150, units={"expected": "m", "actual": "cm"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["dimension"], "length")
        self.assertTrue(self.nc(expected=10, actual=36, units={"expected": "m/s", "actual": "km/h"})["ok"])
        self.assertTrue(self.nc(expected=9.8, actual=9.8, units="m/s^2")["ok"])
        self.assertFalse(self.nc(expected=1.5, actual=1.5, units={"expected": "m", "actual": "cm"})["ok"])

    def test_dimension_mismatch(self):
        r = self.nc(expected=1, actual=1, units={"expected": "m", "actual": "s"})
        self.assertEqual((r["ok"], r["verdict"], r["reason"]), (False, "fail", "dimension_mismatch"))
        r = self.nc(expected=1, actual=1, units={"expected": "N", "actual": "J"})
        self.assertEqual(r["reason"], "dimension_mismatch")

    def test_unknown_unit_is_invalid(self):
        r = self.nc(expected=1, actual=1, units={"expected": "m", "actual": "furlong"})
        self.assertEqual((r["verdict"], r["reason"]), ("invalid", "unknown_unit"))
        r = self.nc(expected=1, actual=1, units={"expected": "m", "actual": "__import__('os')"})
        self.assertEqual(r["verdict"], "invalid")

    def test_bad_arguments(self):
        for kw in [dict(expected="x", actual=1), dict(expected=1, actual=True), dict(expected=1, actual=1, tolerance=-1),
                   dict(expected=1, actual=1, relative="yes"), dict(expected="1/0", actual=1)]:
            self.assertEqual(self.nc(**kw)["verdict"], "invalid", kw)


class Evaluate(unittest.TestCase):
    def test_precision(self):
        r = run("evaluate", {"expr": "pi", "precision": 50})
        self.assertEqual(r["value"], "3.1415926535897932384626433832795028841971693993751")
        self.assertEqual(run("evaluate", {"expr": "1/3", "precision": 5})["value"], "0.33333")
        self.assertEqual(run("evaluate", {"expr": "1/3"})["exact"], "1/3")

    def test_substitutions(self):
        r = run("evaluate", {"expr": "a*x^2 + b", "substitutions": {"a": 2, "x": "sqrt(3)", "b": 0.5}})
        self.assertEqual((r["ok"], r["exact"]), (True, "13/2"))

    def test_unbound_and_undefined(self):
        r = run("evaluate", {"expr": "x + y", "substitutions": {"x": 1}})
        self.assertEqual((r["ok"], r["reason"], r["symbols"]), (False, "unbound_symbols", ["y"]))
        self.assertEqual(run("evaluate", {"expr": "1/(x-2)", "substitutions": {"x": 2}})["reason"], "undefined_expression")

    def test_complex_result_flagged(self):
        r = run("evaluate", {"expr": "sqrt(-4)"})
        self.assertEqual((r["ok"], r["isReal"]), (True, False))

    def test_bad_precision(self):
        for p in [0, 101, 2.5, "10", True]:
            self.assertEqual(run("evaluate", {"expr": "pi", "precision": p})["verdict"], "invalid", p)

    def test_substitution_names_validated(self):
        self.assertEqual(run("evaluate", {"expr": "x", "substitutions": {"__class__": 1}})["verdict"], "invalid")


class ConvertUnits(unittest.TestCase):
    def test_convert(self):
        r = run("convert_units", {"value": 36, "from": "km/h", "to": "m/s"})
        self.assertEqual((r["ok"], r["exact"]), (True, "10"))
        self.assertEqual(run("convert_units", {"value": 180, "from": "deg", "to": "rad"})["exact"], "pi")
        self.assertEqual(run("convert_units", {"value": 1, "from": "kg*m/s^2", "to": "N"})["exact"], "1")

    def test_mismatch(self):
        self.assertEqual(run("convert_units", {"value": 1, "from": "kg", "to": "m"})["reason"], "dimension_mismatch")


class Determinism(unittest.TestCase):
    def test_same_input_same_output(self):
        cases = [("equivalent", {"a": "(x+1)^3", "b": "x^3+3*x^2+3*x"}),
                 ("check_steps", {"steps": ["x^2-1", "(x-1)*(x+1)", "(x-1)^2"]}),
                 ("numeric_check", {"expected": "e", "actual": 2.718, "tolerance": 0.001})]
        for op, args in cases:
            outs = {json.dumps(run(op, args), sort_keys=True) for _ in range(3)}
            self.assertEqual(len(outs), 1, op)


if __name__ == "__main__":
    unittest.main()
