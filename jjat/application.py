"""Flask application factory.

Builds the Flask app, wires in the classifier, loads runtime config,
and registers the blueprints under :mod:`jjat.routes`.  This module
contains **no route handlers** of its own — every endpoint lives in the
appropriate blueprint file.

The repo-root ``app.py`` is the entry point and calls :func:`create_app`.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict

from flask import Flask

from jjat.pipeline import DEFAULT_WORKERS, MAX_WORKERS, MIN_WORKERS, Classifier
from jjat.routes import register_blueprints

# Load .env (project-root) into os.environ.  Per-environment credentials
# live there as JENKINS_<ENV>_USERNAME / JENKINS_<ENV>_API_KEY pairs.
# python-dotenv is a hard dependency (pyproject.toml); import-time
# resolution happens before any route handler reads os.environ.
try:
    from dotenv import load_dotenv as _load_dotenv

    _load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
except ImportError:
    # python-dotenv missing — credentials must be exported by the shell.
    pass

# ============================================================================
# Project paths — resolved once at import time.
#
# jjat/application.py sits one level inside the repo, so
# ``Path(__file__).resolve().parents[1]`` is the project root.  Everything
# user-editable (templates, static, config) lives at the project root,
# NOT inside the package directory, so we anchor on PROJECT_ROOT.
# ============================================================================

PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEMPLATES_DIR = PROJECT_ROOT / "templates"
STATIC_DIR = PROJECT_ROOT / "static"
CONFIG_DIR = PROJECT_ROOT / "config"


def create_app() -> Flask:
    """Create and configure the Flask application.

    Order of operations:

    1. Build a Flask instance with absolute template / static folders.
    2. Set default config (thread pool size, request timeout).
    3. Load the classifier from ``config/rules.yaml``.
    4. Load optional ``config/contexts.json``.
    5. Apply ``JENKINS_MAX_WORKERS`` env override if set (bounded
       :data:`MIN_WORKERS`..\\ :data:`MAX_WORKERS`).
    6. Register every blueprint.

    Returns:
        Configured Flask application.
    """
    # Anchor on absolute paths so Flask finds templates/static regardless
    # of the current working directory — ``jjat/`` itself contains no
    # templates or static assets; they live at the project root.
    app = Flask(
        __name__,
        template_folder=str(TEMPLATES_DIR),
        static_folder=str(STATIC_DIR),
    )

    # ---- defaults ----------------------------------------------------------
    # DEFAULT_WORKERS is the single source of truth — see jjat/pipeline.py.
    app.config["thread_pool_size"] = DEFAULT_WORKERS
    app.config["default_timeout"] = 30

    # ---- classifier --------------------------------------------------------
    # Loaded once at boot; route handlers re-use the same classifier via
    # ``current_app.classifier``.  The path is a directory of per-domain
    # YAML files (config/rules/{01-timeout, 02-ui-locator, …}); the
    # Classifier merges them all and validates rule-name uniqueness.
    # Single-file mode (``rules.yaml``) is still supported as a fallback
    # — pass the file path instead — but the directory layout is the
    # canonical form going forward.
    app.classifier = Classifier(rules_path=str(CONFIG_DIR / "rules"))

    # ---- contexts.json (optional) -----------------------------------------
    app.config["contexts"] = _load_contexts_json()

    # ---- JENKINS_MAX_WORKERS env override --------------------------------
    # One knob, .env-aware (python-dotenv populates os.environ at import
    # time).  Bounded so a typo can't fan out thousands of connections
    # and tip a real Jenkins over.  Silently ignores garbage values.
    env_workers = os.environ.get("JENKINS_MAX_WORKERS", "").strip()
    if env_workers:
        try:
            n = int(env_workers)
            if MIN_WORKERS <= n <= MAX_WORKERS:
                app.config["thread_pool_size"] = n
        except ValueError:
            pass

    # ---- routes ------------------------------------------------------------
    register_blueprints(app)
    return app


def _load_contexts_json() -> Dict[str, Any]:
    """Load and validate ``config/contexts.json``.

    Validates structure:
      * Top-level keys: ``instances`` (array), ``defaults`` (object).
      * Each instance requires: ``id``, ``display_name``, ``jenkins_url``.
      * Each instance has optional ``predefined_job_lists``.
      * Jenkins views are discovered dynamically at runtime — any legacy
        ``predefined_views`` field is stripped.
      * Duplicate instance ``id`` values: first wins, the rest are skipped.
      * Each ``predefined_job_lists[].job_list_file`` is resolved
        relative to the ``contexts.json`` directory.

    Returns:
        Parsed contexts dict, or an empty dict if the file is missing
        or malformed (the app then operates in "manual mode" — user
        types in Jenkins URL + credentials).
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

    # Validate and deduplicate instances.
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

        # Strip legacy fields — views are discovered dynamically now.
        instance.pop("predefined_views", None)
        instance.pop("allow_dynamic_discovery", None)

        # Validate optional predefined_job_lists.  Only ``name`` (shown in
        # the dropdown) and ``job_list_file`` (path to the JSON) are
        # required; older entries may still carry ``id``/``environment``/
        # ``source_mode`` and they are silently passed through for
        # backward compat, but the loader no longer demands them.
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
