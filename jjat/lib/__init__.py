"""Cross-cutting helpers shared by routes and the analysis pipeline.

Each module here is small (< 100 lines), pure where possible, and depends
only on stdlib + ``jjat.models`` / ``jjat.jenkins_client``.  Anything
domain-specific belongs in its own subpackage (``routes/``, ``pipeline/``,
``jenkins/`` …), not in ``lib/``.
"""
