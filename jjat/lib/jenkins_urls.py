"""Pure Jenkins URL composers — no HTTP, no I/O."""


def resolve_view_url(jenkins_url: str, view_path: str) -> str:
    """Join a base URL and view path into ``<base>/<view>/`` (trailing slash)."""
    return jenkins_url.rstrip("/") + "/" + view_path.strip("/") + "/"
