"""Dashboard page + runtime config endpoint.

These two routes don't fit any of the API domains — they're
infrastructure for the page itself.  Kept together so ``application.py``
stays a pure factory.
"""

import json
import time

from flask import Blueprint, current_app, jsonify, render_template

from jjat.pipeline import DEFAULT_WORKERS

bp = Blueprint("dashboard", __name__)


# Asset cache-buster — bound to the time the blueprint module first
# loaded.  Every static JS / CSS link in the template appends
# ``?v={{ asset_v }}``, so a server restart forces the browser to
# refetch all bundles instead of serving stale cached copies.
_ASSET_VERSION = str(int(time.time()))


@bp.app_context_processor
def _inject_asset_version() -> dict:
    """Make ``{{ asset_v }}`` available in every rendered template."""
    return {"asset_v": _ASSET_VERSION}


@bp.route("/", methods=["GET"])
def dashboard() -> str:
    """Serve ``dashboard.html`` with the classifier taxonomy + contexts inline."""
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
    """Return runtime config + analysis taxonomy as JSON.

    Consumed by the frontend at boot to learn the configured worker
    count, the available Jenkins instances, and the colour map for
    classification labels.
    """
    classifier = current_app.classifier  # type: ignore[attr-defined]
    return jsonify({
        # Fallback uses the canonical default so the browser never sees a
        # value that disagrees with what the backend actually runs with.
        "thread_pool_size": current_app.config.get("thread_pool_size", DEFAULT_WORKERS),
        "default_timeout": current_app.config.get("default_timeout", 30),
        "contexts": current_app.config.get("contexts", {}),
        "analysis_taxonomy": {
            "domain_colors": classifier.domain_colors,
            "fallback_labels": classifier.fallback_labels,
        },
    }), 200
