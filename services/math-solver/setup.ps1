# Creates services/math-solver/.venv and installs the hash-pinned requirements (Windows).
#   powershell -ExecutionPolicy Bypass -File services/math-solver/setup.ps1
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
python setup_env.py
if ($LASTEXITCODE -ne 0) { throw "math-solver setup failed" }
