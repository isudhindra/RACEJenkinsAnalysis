"""Plugs every route blueprint into the Flask app. ``register_blueprints(app)``
is called once by the application factory, so the rest of the project only
has to import this one function to expose every HTTP-API endpoint.
"""

from flask import Flask

from race.routes import (
    analysis,
    auth,
    classify_test,
    console,
    dashboard,
    fetch,
    refresh,
    rerun,
    views,
)


def register_blueprints(app: Flask) -> None:
    """Register every blueprint on the Flask app. Dashboard goes first because
    it owns ``/`` and the asset-version context processor templates depend on.
    """
    app.register_blueprint(dashboard.bp)
    app.register_blueprint(auth.bp)
    app.register_blueprint(views.bp)
    app.register_blueprint(fetch.bp)
    app.register_blueprint(refresh.bp)
    app.register_blueprint(analysis.bp)
    app.register_blueprint(console.bp)
    app.register_blueprint(rerun.bp)
    app.register_blueprint(classify_test.bp)
