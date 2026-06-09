"""Flask application factory.

Builds the Flask app, loads the classifier and config, and registers
every blueprint under :mod:`jjat.routes`. No route handlers live here.
The repo-root ``app.py`` is the entry point and calls :func:`create_app`.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict

from flask import Flask

from jjat.pipeline import DEFAULT_WORKERS, MAX_WORKERS, MIN_WORKERS, Classifier
from jjat.routes import register_blueprints

# Populate os.environ from .env at import time, before any route handler reads credentials.
try:
    from dotenv import load_dotenv as _load_dotenv

    _load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
except ImportError:
    # python-dotenv missing — fall back to whatever the shell exported.
    pass

# Boot-time diagnostic: confirm whether env-auth credentials are actually
# visible to this Python process. Printed once on import; lets the user
# distinguish "shell var not exported" from "frontend never asks".
try:
    from jjat.lib.credentials import ENV_API_KEY_VAR, ENV_USERNAME_VAR, env_credentials

    _env_user, _env_key = env_credentials()
    if _env_user and _env_key:
        print(f"[INFO] Env-auth detected — {ENV_USERNAME_VAR}=<set> {ENV_API_KEY_VAR}=<set>")
    else:
        _missing = []
        if not _env_user:
            _missing.append(ENV_USERNAME_VAR)
        if not _env_key:
            _missing.append(ENV_API_KEY_VAR)
        print(f"[INFO] Env-auth NOT available — missing: {', '.join(_missing)} (manual auth only)")
except Exception:  # pragma: no cover — defensive, never block startup
    pass

# Templates / static / config live at the project root, not inside the package.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEMPLATES_DIR = PROJECT_ROOT / "templates"
STATIC_DIR = PROJECT_ROOT / "static"
CONFIG_DIR = PROJECT_ROOT / "config"


def create_app() -> Flask:
    """Create and configure the Flask application.

    Builds the Flask instance, applies defaults, loads the classifier
    and optional ``contexts.json``, applies any ``JENKINS_MAX_WORKERS``
    env override, and registers all blueprints.
    """
    app = Flask(
        __name__,
        template_folder=str(TEMPLATES_DIR),
        static_folder=str(STATIC_DIR),
    )

    app.config["thread_pool_size"] = DEFAULT_WORKERS
    app.config["default_timeout"] = 30

    # Classifier is loaded once at boot and shared via current_app.classifier.
    # Directory mode merges per-domain YAML files; single-file mode is a fallback.
    app.classifier = Classifier(rules_path=str(CONFIG_DIR / "rules"))

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
    return app


def _load_contexts_json() -> Dict[str, Any]:
    """Load and validate ``config/contexts.json``.

    Returns an empty dict when the file is missing or malformed — the
    app then runs in manual mode (user types in Jenkins URL + creds).
    Each instance needs ``id``, ``display_name``, ``jenkins_url``; the
    first occurrence of any duplicate id wins. ``predefined_job_lists``
    paths are resolved relative to the contexts.json directory.
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
