"""Pure helpers that build canonical Jenkins URLs from a folder or view
path. No HTTP, no I/O — just string work, so it's safe to use anywhere
without worrying about side effects.
"""


def resolve_view_url(jenkins_url: str, view_path: str) -> str:
    """Join base URL and view path into <base>/<view>/ with a trailing slash."""
    return jenkins_url.rstrip("/") + "/" + view_path.strip("/") + "/"
