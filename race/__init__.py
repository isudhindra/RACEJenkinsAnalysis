"""RACE — Release Assurance & Confidence Engine — a local Flask dashboard that fetches
Jenkins job results, classifies failures, and helps decide whether a release is
safe to promote.
"""

from race.application import create_app

__version__ = "0.1.0"
__all__ = ["create_app", "__version__"]
