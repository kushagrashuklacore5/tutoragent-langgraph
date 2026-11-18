"""Unit handling over a fixed whitelist of sympy.physics.units quantities.

Unit strings ("m", "km/h", "m/s^2", "kg*m^2/s^2") go through the same whitelist parser as
expressions, but names resolve only to the units below; any other name is rejected. Temperature
scales with offsets (degC/degF) are intentionally not supported.
"""
from __future__ import annotations

import sympy as sp
from sympy.physics import units as u
from sympy.physics.units.systems.si import SI, dimsys_SI

from .safe_parse import ParseError, parse

UNITS: dict[str, sp.Expr] = {
    # length
    "m": u.meter, "meter": u.meter, "metre": u.meter, "km": u.kilometer, "cm": u.centimeter,
    "mm": u.millimeter, "um": u.micrometer, "nm": u.nanometer, "inch": u.inch, "ft": u.foot,
    "mi": u.mile,
    # mass
    "kg": u.kilogram, "g": u.gram, "mg": u.milligram, "t": u.tonne,
    # time
    "s": u.second, "ms": u.millisecond, "us": u.microsecond, "min": u.minute, "h": u.hour,
    "hr": u.hour, "day": u.day,
    # derived SI
    "N": u.newton, "J": u.joule, "kJ": u.kilo * u.joule, "W": u.watt, "kW": u.kilo * u.watt, "Pa": u.pascal,
    "kPa": u.kilo * u.pascal, "bar": u.bar, "atm": u.atmosphere, "Hz": u.hertz, "C": u.coulomb,
    "A": u.ampere, "mA": u.milli * u.ampere, "V": u.volt, "ohm": u.ohm, "F": u.farad, "T": u.tesla,
    "K": u.kelvin, "mol": u.mole, "cd": u.candela, "eV": u.electronvolt, "cal": sp.Rational(4184, 1000) * u.joule,
    "kcal": 4184 * u.joule,
    # volume
    "L": u.liter, "l": u.liter, "mL": u.milliliter, "ml": u.milliliter,
    # angle (dimensionless in SI)
    "rad": u.radian, "deg": u.degree,
}

_DIM_CACHE: dict[str, dict[str, int]] = {}


class UnitError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def parse_unit(text: str) -> sp.Expr:
    """Parse a unit expression such as 'm/s^2'. An empty string or '1' means dimensionless."""
    if text is None or (isinstance(text, str) and text.strip() in ("", "1")):
        return sp.Integer(1)
    try:
        expr = parse(text, symbols=UNITS, allow_any_symbol=False)
    except ParseError as e:
        if e.code == "unknown_name":
            raise UnitError("unknown_unit", e.message.replace("name", "unit")) from None
        raise UnitError("invalid_unit", e.message) from None
    return expr


def dimension_of(unit: sp.Expr) -> dict[str, int]:
    key = sp.srepr(unit)
    if key not in _DIM_CACHE:
        deps = dimsys_SI.get_dimensional_dependencies(SI.get_dimensional_expr(unit))
        _DIM_CACHE[key] = {str(dim.name): int(power) for dim, power in deps.items()}
    return dict(_DIM_CACHE[key])


def format_dimension(dims: dict[str, int]) -> str:
    if not dims:
        return "dimensionless"
    return "*".join(f"{k}^{v}" if v != 1 else k for k, v in sorted(dims.items()))


def conversion_factor(from_unit: sp.Expr, to_unit: sp.Expr) -> sp.Expr:
    """Exact factor f such that  value[from_unit] == value * f [to_unit].  Raises on dimension mismatch."""
    d_from, d_to = dimension_of(from_unit), dimension_of(to_unit)
    if d_from != d_to:
        raise UnitError("dimension_mismatch",
                        f"cannot convert {format_dimension(d_from)} to {format_dimension(d_to)}")
    base = _base_units()
    angles = {u.degree: sp.pi / 180, u.radian: sp.Integer(1)}  # angles are dimensionless in SI
    factor = u.convert_to(from_unit.subs(angles), base) / u.convert_to(to_unit.subs(angles), base)
    # constants such as the electronvolt are stored as decimals; keep the arithmetic exact
    factor = sp.simplify(factor.xreplace({f: sp.Rational(str(f)) for f in factor.atoms(sp.Float)}))
    if factor.free_symbols or not factor.is_number:
        raise UnitError("conversion_failed", "units could not be reduced to a numeric factor")
    return factor


def _base_units() -> list[sp.Expr]:
    return [u.meter, u.kilogram, u.second, u.ampere, u.kelvin, u.mole, u.candela]
