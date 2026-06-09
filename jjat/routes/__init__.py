"""Flask blueprints — one per HTTP-API domain.

Each file owns its routes plus any domain-only helpers; cross-cutting
helpers live in :mod:`jjat.lib`.
"""

from flask import Flask

from jjat.routes import (
    analysis,
    auth,
    console,
    dashboard,
    fetch,
    refresh,
    rerun,
    views,
)


def register_blueprints(app: Flask) -> None:
    """Register every blueprint on the Flask app.

    Dashboard goes first because it owns ``/`` and the asset-version
    context processor every template depends on.
    """
    app.register_blueprint(dashboard.bp)
    app.register_blueprint(auth.bp)
    app.register_blueprint(views.bp)
    app.register_blueprint(fetch.bp)
    app.register_blueprint(refresh.bp)
    app.register_blueprint(analysis.bp)
    app.register_blueprint(console.bp)
    app.register_blueprint(rerun.bp)
