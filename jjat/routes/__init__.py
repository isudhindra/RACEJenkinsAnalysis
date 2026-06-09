"""Flask blueprints — one per HTTP-API domain.

``register_blueprints(app)`` wires them all into a single Flask app.
Each blueprint file owns its own routes plus any helpers used only by
that domain.  Cross-cutting helpers live in :mod:`jjat.lib`.
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
    """Register every blueprint on the given Flask app.

    Call from :func:`jjat.application.create_app` once the app and its
    classifier / config have been initialised.  Order does not matter —
    blueprints carry their own URL prefixes — but ``dashboard`` is
    registered first because it owns the ``/`` route and the asset-
    version context processor that every template uses.
    """
    app.register_blueprint(dashboard.bp)
    app.register_blueprint(auth.bp)
    app.register_blueprint(views.bp)
    app.register_blueprint(fetch.bp)
    app.register_blueprint(refresh.bp)
    app.register_blueprint(analysis.bp)
    app.register_blueprint(console.bp)
    app.register_blueprint(rerun.bp)
