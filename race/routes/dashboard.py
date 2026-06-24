"""Serves the main ``dashboard.html`` page and the ``/api/config`` endpoint
the frontend reads on boot. Also injects the per-session X-RACE-Token into a
meta tag so JS can authenticate every API call.
"""

import time

from flask import Blueprint, current_app, jsonify, render_template

from race.pipeline import DEFAULT_WORKERS

bp = Blueprint("dashboard", __name__)


# Cache-buster appended to every static asset URL — a server restart
# forces browsers to refetch instead of serving stale bundles.
_ASSET_VERSION = str(int(time.time()))


@bp.app_context_processor
def _inject_asset_version() -> dict:
    """Expose ``{{ asset_v }}`` to every template so static URLs cache-bust on restart."""
    return {"asset_v": _ASSET_VERSION}


@bp.route("/", methods=["GET"])
def dashboard() -> str:
    """Serve dashboard.html with classifier taxonomy and contexts inlined as JSON.
    Also injects the per-session X-RACE-Token into a meta tag for the JS API client.
    """
    classifier = current_app.classifier  # type: ignore[attr-defined]
    taxonomy = {
        "domain_colors": classifier.domain_colors,
        "fallback_labels": classifier.fallback_labels,
    }
    # dicts are passed straight through — the template uses |tojson for HTML-safe encoding.
    return render_template(
        "dashboard.html",
        contexts=current_app.config.get("contexts", {}),
        analysis_taxonomy=taxonomy,
        auto_refresh_interval_ms=int(current_app.config.get("auto_refresh_interval_ms", 30000)),
        # Plumbed into a meta tag; apiFetch() reads it and adds X-RACE-Token to every /api/* call.
        local_api_token=current_app.config.get("LOCAL_API_TOKEN", ""),
    )


@bp.route("/api/config", methods=["GET"])
def get_config():
    """Return runtime config and analysis taxonomy as JSON for frontend boot."""
    classifier = current_app.classifier  # type: ignore[attr-defined]
    return jsonify({
        # Fallback uses the canonical default so the browser never disagrees with the backend.
        "thread_pool_size": current_app.config.get("thread_pool_size", DEFAULT_WORKERS),
        "default_timeout": current_app.config.get("default_timeout", 30),
        # Same value as the template injection
        "auto_refresh_interval_ms": int(current_app.config.get("auto_refresh_interval_ms", 30000)),
        "contexts": current_app.config.get("contexts", {}),
        "analysis_taxonomy": {
            "domain_colors": classifier.domain_colors,
            "fallback_labels": classifier.fallback_labels,
        },
    }), 200
