"""Flask application factory. Builds the app, loads the classifier rules,
registers every blueprint, and wires up the local-API token guard, rate
limiter, and security headers. The repo-root app.py just calls create_app().
"""

import json
import os
import secrets
import stat
from pathlib import Path
from typing import Any, Dict

from flask import Flask

from race.pipeline import DEFAULT_WORKERS, MAX_WORKERS, MIN_WORKERS, Classifier
from race.routes import register_blueprints

# Populate os.environ from .env at import time, before any route handler reads credentials.
try:
    from dotenv import load_dotenv as _load_dotenv

    _ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
    _load_dotenv(_ENV_PATH, override=False)

    # .env carries the only on-disk copy of JENKINS_TEST_API_KEY. Warn if
    # the user's umask left it readable beyond owner (default macOS umask
    # is 0644). Warning-only — boot continues.
    try:
        if _ENV_PATH.exists() and hasattr(os, "getuid"):
            _env_mode = _ENV_PATH.stat().st_mode & 0o777
            if _env_mode & 0o077:
                print(
                    f"[WARN] {_ENV_PATH} is mode {oct(_env_mode)} — readable beyond owner. "
                    f"Recommended: chmod 600 {_ENV_PATH} so only your user can read it."
                )
    except OSError:
        pass
except ImportError:
    # python-dotenv missing — fall back to whatever the shell exported.
    pass

# Boot-time diagnostic: did env-auth credentials make it into the process?
try:
    from race.lib.credentials import ENV_API_KEY_VAR, ENV_USERNAME_VAR, env_credentials
    from race.lib.security import debug_log as _debug_log

    _env_user, _env_key = env_credentials()
    if _env_user and _env_key:
        _debug_log(f"[INFO] Env-auth detected — {ENV_USERNAME_VAR}=<set> {ENV_API_KEY_VAR}=<set>")
    else:
        _missing = []
        if not _env_user:
            _missing.append(ENV_USERNAME_VAR)
        if not _env_key:
            _missing.append(ENV_API_KEY_VAR)
        _debug_log(f"[INFO] Env-auth NOT available — missing: {', '.join(_missing)} (manual auth only)")
except Exception:  # pragma: no cover — defensive, never block startup
    pass

# Templates / static / config live at the project root, not inside the package.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEMPLATES_DIR = PROJECT_ROOT / "templates"
STATIC_DIR = PROJECT_ROOT / "static"
CONFIG_DIR = PROJECT_ROOT / "config"


def create_app() -> Flask:
    """Build the Flask app, load the classifier and contexts.json, and register every blueprint.
    Honours JENKINS_MAX_WORKERS / JENKINS_REQUEST_TIMEOUT env overrides.
    """
    app = Flask(
        __name__,
        template_folder=str(TEMPLATES_DIR),
        static_folder=str(STATIC_DIR),
    )

    app.config["thread_pool_size"] = DEFAULT_WORKERS

    # Per-call Jenkins HTTP timeout (seconds).
    app.config["default_timeout"] = 30
    env_timeout = os.environ.get("JENKINS_REQUEST_TIMEOUT", "").strip()
    if env_timeout:
        try:
            t = float(env_timeout)
            if 5.0 <= t <= 120.0:
                app.config["default_timeout"] = t
        except ValueError:
            pass

    # Auto-refresh poll cadence (ms).
    app.config["auto_refresh_interval_ms"] = 30000
    env_ar = os.environ.get("RACE_AUTO_REFRESH_INTERVAL_MS", "").strip()
    if env_ar:
        try:
            n = int(env_ar)
            if 5000 <= n <= 600000:
                app.config["auto_refresh_interval_ms"] = n
        except ValueError:
            pass

    app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024

    app.config["LOCAL_API_TOKEN"] = _ensure_local_api_token()

    from race.lib.security import install_security_headers, install_local_api_token_guard
    install_security_headers(app)
    install_local_api_token_guard(app)

    try:
        from flask_limiter import Limiter
        from flask_limiter.util import get_remote_address

        limiter = Limiter(
            get_remote_address,
            app=app,
            default_limits=["60/minute"],
            storage_uri="memory://",
            strategy="fixed-window",
        )
        app.config["_limiter"] = limiter

        from flask import jsonify

        @app.errorhandler(429)
        def _ratelimit_handler(e):
            return jsonify({
                "error": "Rate limit exceeded",
                "detail": getattr(e, "description", "Too many requests"),
            }), 429
    except ImportError:
        app.config["_limiter"] = None
        print("[WARN] flask-limiter not installed — rate limits disabled")

    # Classifier loaded once at boot and shared via current_app.classifier.
    rules_dir = str(CONFIG_DIR / "rules")
    app.classifier = Classifier(rules_path=rules_dir)

    # Opt-in hot-reload of rule YAMLs. Off by default so attacker-writable
    # files can't silently rebuild the classifier.
    if os.environ.get("RACE_HOT_RELOAD", "").strip().lower() in ("1", "true", "yes"):
        from race.lib.classifier_reloader import start_rules_watcher
        start_rules_watcher(app, rules_dir=rules_dir)

    app.config["contexts"] = _load_contexts_json()

    # Bounded override — a typo must not fan out thousands of connections to Jenkins.
    env_workers = os.environ.get("JENKINS_MAX_WORKERS", "").strip()
    if env_workers:
        try:
            n = int(env_workers)
            if MIN_WORKERS <= n <= MAX_WORKERS:
                app.config["thread_pool_size"] = n
        except ValueError:
            pass

    register_blueprints(app)

    _limiter = app.config.get("_limiter")
    if _limiter is not None:
        for endpoint, view in list(app.view_functions.items()):
            rates = getattr(view, "_race_rate_limits", None)
            if rates:
                for rate in rates:
                    _limiter.limit(rate)(view)

    return app


def _ensure_local_api_token() -> str:
    """Mint a fresh per-machine API token on every boot (the default), or
    reuse a stable one when ``RACE_FRESH_TOKEN_ON_BOOT=0``.

    Stored at ~/.race/token (mode 0600) so curl / CI callers can read it
    during the session. Refuses to touch a symlinked or wrong-owned file
    (surfaces a warning and falls back to an in-memory token instead).
    """
    race_dir = Path.home() / ".race"
    token_file = race_dir / "token"
    my_uid = os.getuid() if hasattr(os, "getuid") else None  # None on Windows
    fresh_on_boot = os.environ.get("RACE_FRESH_TOKEN_ON_BOOT", "1").strip() != "0"
    try:
        # Dir: must be a real, owner-owned directory.
        try:
            dir_st = os.lstat(str(race_dir))
            if stat.S_ISLNK(dir_st.st_mode):
                raise RuntimeError(
                    f"Refusing to use {race_dir} — it is a symbolic link. "
                    f"Remove it manually and restart RACE."
                )
            if not stat.S_ISDIR(dir_st.st_mode):
                raise RuntimeError(f"{race_dir} exists but is not a directory.")
            if my_uid is not None and dir_st.st_uid != my_uid:
                raise RuntimeError(
                    f"Refusing to use {race_dir} — owned by uid {dir_st.st_uid}, "
                    f"expected {my_uid}."
                )
            try:
                os.chmod(str(race_dir), 0o700)
            except OSError:
                pass
        except FileNotFoundError:
            os.mkdir(str(race_dir), mode=0o700)

        # Inspect any existing token file. NEVER blindly unlink a symlink or
        # wrong-owned file — surface the anomaly instead so the user sees it.
        try:
            file_st = os.lstat(str(token_file))
            if stat.S_ISLNK(file_st.st_mode):
                raise RuntimeError(
                    f"Refusing to touch {token_file} — it is a symbolic link. "
                    f"Remove it manually and restart RACE."
                )
            if my_uid is not None and file_st.st_uid != my_uid:
                raise RuntimeError(
                    f"Refusing to touch {token_file} — owned by uid "
                    f"{file_st.st_uid}, expected {my_uid}. Remove it manually "
                    f"and restart RACE."
                )
            # Regular, owner-owned file. Opt-out path: read and reuse it.
            if not fresh_on_boot and file_st.st_size > 0:
                fd = os.open(
                    str(token_file),
                    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                )
                try:
                    existing = os.read(fd, 256).decode("utf-8").strip()
                finally:
                    os.close(fd)
                if len(existing) >= 32:
                    print(
                        f"[INFO] Stable API token loaded from {token_file} "
                        f"(RACE_FRESH_TOKEN_ON_BOOT=0)"
                    )
                    return existing
            # Default path (or opt-out with corrupt file): remove the safe
            # existing file so the atomic-write block below can recreate it.
            os.unlink(str(token_file))
        except FileNotFoundError:
            pass

        # Generate + atomic write. O_EXCL + O_NOFOLLOW defeats a planted
        # symlink at the .tmp path.
        token = secrets.token_hex(32)
        tmp = token_file.with_suffix(".tmp")
        try:
            os.unlink(str(tmp))
        except FileNotFoundError:
            pass
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(str(tmp), flags, 0o600)
        try:
            os.write(fd, token.encode("utf-8"))
        finally:
            os.close(fd)
        os.replace(str(tmp), str(token_file))
        if fresh_on_boot:
            print(f"[INFO] Fresh API token written to {token_file} for this session")
        else:
            print(
                f"[INFO] Stable API token written to {token_file} "
                f"(RACE_FRESH_TOKEN_ON_BOOT=0 — persists across restarts)"
            )
        return token
    except (OSError, RuntimeError, UnicodeDecodeError) as e:
        # In-memory fallback. Covers disk-full / read-only HOME, symlinked
        # or wrong-owned file, and other unusual filesystem states.
        # Never prints the literal token — only a short SHA-256 fingerprint.
        import hashlib
        token = secrets.token_hex(32)
        fp = hashlib.sha256(token.encode()).hexdigest()[:8]
        print(
            f"[WARN] {token_file} unavailable ({e}); using an in-memory token "
            f"for this session — fingerprint=sha256:{fp}. curl / CI scripts "
            f"that read the file will not work this session; fix the underlying "
            f"issue (remove any symlink at {token_file}, free HOME, etc.) and "
            f"restart to restore."
        )
        return token


def _load_contexts_json() -> Dict[str, Any]:
    """Load and validate config/contexts.json, returning {} when missing or malformed.
    Invalid instances are skipped; duplicate ids keep only the first occurrence.
    """
    contexts_path = CONFIG_DIR / "contexts.json"
    try:
        with open(contexts_path) as f:
            data = json.load(f)
    except FileNotFoundError:
        print("[INFO] contexts.json not found — operating in manual mode")
        return {}
    except json.JSONDecodeError as e:
        print(f"[WARN] contexts.json is malformed: {e} — operating in manual mode")
        return {}

    if "instances" not in data or not isinstance(data["instances"], list):
        print("[WARN] contexts.json missing 'instances' array — operating in manual mode")
        return {}

    instance_required = {"id", "display_name", "jenkins_url"}
    seen_ids: set = set()
    valid_instances = []
    contexts_dir = os.path.dirname(os.path.abspath(contexts_path))

    for idx, instance in enumerate(data["instances"]):
        missing = instance_required - set(instance.keys())
        if missing:
            print(f"[WARN] Instance at index {idx} missing fields {missing} — skipped")
            continue

        if instance["id"] in seen_ids:
            print(f"[WARN] Duplicate instance id '{instance['id']}' at index {idx} — skipped")
            continue
        seen_ids.add(instance["id"])

        # Legacy fields — views are discovered dynamically now.
        instance.pop("predefined_views", None)
        instance.pop("allow_dynamic_discovery", None)

        # Older job-list entries may carry extra fields; only name + file are required.
        job_list_required = {"name", "job_list_file"}
        if "predefined_job_lists" in instance and isinstance(instance["predefined_job_lists"], list):
            valid_lists = []
            for jl_idx, jl in enumerate(instance["predefined_job_lists"]):
                jl_missing = job_list_required - set(jl.keys())
                if jl_missing:
                    print(
                        f"[WARN] Instance '{instance['id']}' job_list at index "
                        f"{jl_idx} missing fields {jl_missing} — skipped"
                    )
                    continue
                jl["job_list_file"] = os.path.join(contexts_dir, jl["job_list_file"])
                valid_lists.append(jl)
            instance["predefined_job_lists"] = valid_lists

        valid_instances.append(instance)

    data["instances"] = valid_instances
    return data
