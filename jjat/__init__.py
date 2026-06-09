"""Jenkins Job Analysis Tool — local dashboard for release validation.

Package root.  Exposes the version string and re-exports the Flask app
factory so callers can do::

    from jjat import create_app
    app = create_app()
"""

from jjat.application import create_app

__version__ = "0.1.0"
__all__ = ["create_app", "__version__"]
