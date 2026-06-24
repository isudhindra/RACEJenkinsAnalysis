"""Background watcher that hot-reloads `config/rules/*.yaml` when the files
change, so rule authoring doesn't need a Flask restart. Off by default —
opt in with `RACE_HOT_RELOAD=1`.
"""

from __future__ import annotations

import glob
import os
import threading
import time
from typing import Dict, Optional

from race.pipeline import Classifier


# Cap the in-memory error log so a broken YAML doesn't grow unbounded.
_MAX_ERROR_HISTORY = 50

# PyYAML errors echo source bytes; cap + scrub before storing so the diag
# panel can't carry attacker-controlled binary content.
_MAX_ERROR_MSG_LEN = 500


def _sanitize_error_message(message: str) -> str:
    """Strip non-printable bytes and cap length, keeping newlines and tabs."""
    s = str(message)[:_MAX_ERROR_MSG_LEN]
    return "".join(
        c if (32 <= ord(c) <= 126 or c in "\n\t") else "?"
        for c in s
    )


def start_rules_watcher(
    app,
    rules_dir: str,
    poll_interval: Optional[float] = None,
) -> threading.Thread:
    """Spawn a daemon thread that hot-reloads the classifier on YAML change.
    Poll interval defaults to 5s; override via RACE_RULES_RELOAD_INTERVAL.
    """
    if poll_interval is None:
        env_val = os.environ.get("RACE_RULES_RELOAD_INTERVAL", "").strip()
        try:
            poll_interval = float(env_val) if env_val else 5.0
        except ValueError:
            poll_interval = 5.0
    # Clamp to a sane range so a typo can't pin the thread or starve it.
    poll_interval = max(0.5, min(poll_interval, 600.0))

    def _snapshot() -> Dict[str, float]:
        """Map every rule YAML to its current mtime; empty on filesystem error."""
        out: Dict[str, float] = {}
        try:
            for path in glob.glob(os.path.join(rules_dir, "*.yaml")):
                try:
                    out[path] = os.path.getmtime(path)
                except OSError:
                    # File vanished between glob and stat — ignore.
                    pass
        except OSError:
            pass
        return out

    def _record_error(message: str) -> None:
        bucket = app.config.setdefault("_rules_reload_errors", [])
        bucket.append({"ts": time.time(), "error": _sanitize_error_message(message)})
        if len(bucket) > _MAX_ERROR_HISTORY:
            del bucket[: len(bucket) - _MAX_ERROR_HISTORY]

    def _loop() -> None:
        last_snapshot = _snapshot()
        while True:
            time.sleep(poll_interval)
            current = _snapshot()
            if current == last_snapshot:
                continue
            last_snapshot = current
            try:
                new_classifier = Classifier(rules_path=rules_dir)
            except Exception as exc:
                msg = f"[rules-reload] FAILED — keeping previous classifier — {exc}"
                try:
                    app.logger.warning(msg)
                except Exception:
                    print(msg)
                _record_error(str(exc))
                continue
            # Atomic attribute swap — readers see either old or new, never a half-built object.
            app.classifier = new_classifier
            msg = f"[rules-reload] OK — {len(new_classifier.rules)} rules loaded"
            try:
                app.logger.info(msg)
            except Exception:
                print(msg)

    thread = threading.Thread(target=_loop, daemon=True, name="rules-watcher")
    thread.start()
    app.config["_rules_watcher_thread"] = thread
    app.config["_rules_watcher_interval"] = poll_interval
    return thread


def get_recent_reload_errors(app) -> list:
    """Return the in-memory list of recent reload errors, newest last."""
    return list(app.config.get("_rules_reload_errors", []))
