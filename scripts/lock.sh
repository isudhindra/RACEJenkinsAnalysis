#!/usr/bin/env bash
# Regenerate requirements.lock.txt from pyproject.toml. Run after editing
# the `dependencies` block. Non-hashed by design — see README.


set -euo pipefail

# Pin to the minimum Python this project supports — keep in sync with
# requires-python in pyproject.toml.
MIN_PY_MAJOR=3
MIN_PY_MINOR=10

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

# Fail fast if the interpreter is older or newer than required.
PY_VER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
PY_MAJOR="${PY_VER%.*}"
PY_MINOR="${PY_VER#*.}"

if [ "$PY_MAJOR" -ne "$MIN_PY_MAJOR" ] || [ "$PY_MINOR" -lt "$MIN_PY_MINOR" ]; then
    echo "ERROR: lock.sh requires Python ${MIN_PY_MAJOR}.${MIN_PY_MINOR}.x to match" >&2
    echo "       requires-python in pyproject.toml. Current: ${PY_VER}" >&2
    echo "       Use pyenv/venv/uv to run this script under Python ${MIN_PY_MAJOR}.${MIN_PY_MINOR}." >&2
    exit 1
fi

if ! command -v pip-compile >/dev/null 2>&1; then
    echo "ERROR: pip-compile not found. Install it with:" >&2
    echo "       pip install pip-tools" >&2
    exit 1
fi

pip-compile --strip-extras --quiet --output-file=requirements.lock.txt pyproject.toml
echo "✓ requirements.lock.txt regenerated from pyproject.toml (Python ${PY_VER})"
