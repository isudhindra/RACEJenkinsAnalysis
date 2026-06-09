"""Dashboard page + runtime config endpoint — infrastructure for the page itself."""

import json
import time

from flask import Blueprint, current_app, jsonify, render_template

from jjat.pipeline import DEFAULT_WORKERS

bp = Blueprint("dashboard", __name__)


# Cache-buster appended to every static asset URL — a server restart
# forces browsers to refetch instead of serving stale bundles.
_ASSET_VERSION = str(int(time.time()))


@bp.app_context_processor
def _inject_asset_version() -> dict:
    """Make ``{{ asset_v }}`` available in every rendered template."""
    return {"asset_v": _ASSET_VERSION}


@bp.route("/", methods=["GET"])
def dashboard() -> str:
    """Serve ``dashboard.html`` with classifier taxonomy + contexts inlined as JSON."""
    classifier = current_app.classifier  # type: ignore[attr-defined]
    taxonomy = {
        "domain_colors": classifier.domain_colors,
        "fallback_labels": classifier.fallback_labels,
    }
    return render_template(
        "dashboard.html",
        contexts=json.dumps(current_app.config.get("contexts", {})),
        analysis_taxonomy=json.dumps(taxonomy),
    )


@bp.route("/api/config", methods=["GET"])
def get_config():
    """Return runtime config + analysis taxonomy as JSON, consumed at frontend boot."""
    classifier = current_app.classifier  # type: ignore[attr-defined]
    return jsonify({
        # Fallback uses the canonical default so the browser never disagrees with the backend.
        "thread_pool_size": current_app.config.get("thread_pool_size", DEFAULT_WORKERS),
        "default_timeout": current_app.config.get("default_timeout", 30),
        "contexts": current_app.config.get("contexts", {}),
        "analysis_taxonomy": {
            "domain_colors": classifier.domain_colors,
            "fallback_labels": classifier.fallback_labels,
        },
    }), 200
