#!/usr/bin/env bash
# Token help — explains how the local API token works. Does NOT rotate
# anything. Rotation happens automatically every time RACE starts.

cat <<'EOF'
RACE's local API token (~/.race/token) is rotated automatically on every
server restart. There is no "rotate while running" command — that's by design.

To force a rotation:
  1. Stop RACE in the terminal it's running in (Ctrl+C).
  2. Run 'analyseJenkins' again.
  3. In any open browser tab, hard-refresh once (Cmd/Ctrl + Shift + R).

If RACE refused to write ~/.race/token at startup (symlinked, wrong owner,
or unwritable) it logs an "in-memory token … fingerprint=sha256:…" warning
and runs with a session-only token. To restore on-disk persistence: fix
the underlying file permission / ownership / symlink, then restart RACE.

Curl / CI consumers can pick up the current token with:
  curl -H "X-RACE-Token: $(cat ~/.race/token)" http://127.0.0.1:5000/api/...
EOF
