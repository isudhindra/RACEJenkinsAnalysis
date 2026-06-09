"""Entry point — preserves the `python app.py` workflow.

This file is intentionally tiny.  All Flask routes, models, and the
Jenkins client live inside the ``jjat`` package at the repo root.
Keeping the entry script at the project root means existing
instructions ("from the project folder, run ``python app.py``") still
work, the ``analyseJenkins`` shell alias still works, and IDE
run-configurations need no update.

Workflow:

    python app.py        # starts the dev server on http://127.0.0.1:5000
    # or, after running scripts/setup.sh:
    analyseJenkins

The ``jjat`` package is a sibling directory of this file, so Python
finds it on the default ``sys.path`` (cwd) — no path manipulation
needed.
"""

import os
import threading
import time
import webbrowser

from jjat.application import create_app

# Build the Flask app at module load so WSGI servers (gunicorn,
# uvicorn-asgi-bridge, etc.) can import `app` directly:  `gunicorn app:app`.
app = create_app()


def _open_browser_after_delay(url: str, delay_seconds: float = 1.5) -> None:
    """Open the dashboard in the user's default browser after a short delay.

    The delay lets the Flask dev server bind to the socket before the
    browser tries to load the page; otherwise the user sees a stale
    "site cannot be reached" tab.
    """
    time.sleep(delay_seconds)
    try:
        webbrowser.open(url)
    except Exception:
        # Browser launch is best-effort — never fatal.
        pass


if __name__ == "__main__":
    port = int(os.environ.get("JJAT_PORT", "5000"))
    url = f"http://127.0.0.1:{port}"

    # Auto-open the browser on first launch, in a daemon thread so it
    # doesn't block the server boot.
    threading.Thread(
        target=_open_browser_after_delay,
        args=(url,),
        daemon=True,
    ).start()

    # Local tool: bind to loopback only.  Do NOT expose on all interfaces.
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
