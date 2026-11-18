"""Create services/math-solver/.venv and install the hash-pinned requirements into it.

    python setup_env.py          (any OS; Python 3.12+)

Never installs into the interpreter that runs this script.
"""
import os
import subprocess
import sys
import venv

HERE = os.path.dirname(os.path.abspath(__file__))
VENV = os.path.join(HERE, ".venv")


def main() -> None:
    if sys.version_info < (3, 12):
        sys.exit("Python 3.12+ is required")
    if not os.path.isdir(VENV):
        venv.EnvBuilder(with_pip=True, clear=False).create(VENV)
    py = os.path.join(VENV, "Scripts", "python.exe") if os.name == "nt" else os.path.join(VENV, "bin", "python")
    subprocess.check_call([py, "-m", "pip", "install", "--disable-pip-version-check", "--require-hashes",
                           "--only-binary=:all:", "--no-deps", "-r", os.path.join(HERE, "requirements.txt")])
    subprocess.check_call([py, "-c", "import sympy, mpmath; print('sympy', sympy.__version__, 'mpmath', mpmath.__version__)"])
    print(f"ready: {py}")


if __name__ == "__main__":
    main()
