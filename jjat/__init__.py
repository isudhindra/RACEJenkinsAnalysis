"""Jenkins Job Analysis Tool — local dashboard for release validation.

Re-exports :func:`create_app` so callers can ``from jjat import create_app``.
"""

from jjat.application import create_app

__version__ = "0.1.0"
__all__ = ["create_app", "__version__"]
