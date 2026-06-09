"""Pure Jenkins URL construction helpers.

No HTTP, no I/O — these are small composers used across multiple route
handlers.  Kept in ``lib/`` because they have no domain knowledge and
no side effects.
"""


def resolve_view_url(jenkins_url: str, view_path: str) -> str:
    """Resolve a view path to a full view URL with a trailing slash.

    Args:
        jenkins_url: Base Jenkins URL (with or without trailing slash).
        view_path: Relative view path (e.g. ``"view/My-View"``).

    Returns:
        Full URL of the form ``"<base>/view/My-View/"``.
    """
    return jenkins_url.rstrip("/") + "/" + view_path.strip("/") + "/"
