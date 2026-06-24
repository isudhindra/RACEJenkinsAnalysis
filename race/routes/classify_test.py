"""Sandbox endpoint (``/api/classify-test``) for the dashboard's Test
Classification panel. Takes arbitrary log text, runs it through the live
classifier, and returns the matched rule — no Jenkins call.
"""

import os
import shutil
import tempfile

import yaml
from flask import Blueprint, current_app, jsonify, request

from race.lib.security import limit, require_local_origin
from race.pipeline import Classifier

bp = Blueprint("classify_test", __name__)

# Hard cap so a hostile or accidental huge paste can't pin a worker.
_MAX_LOG_BYTES = 2 * 1024 * 1024  # 2 MB
_MAX_YAML_BYTES = 64 * 1024  # 64 KB — rules are tiny; this is generous.


@bp.route("/api/classify-test", methods=["POST"])
@limit("5/minute")
def classify_test():
    """Classify console_text against the live rules, optionally with a candidate YAML
    layered on top in a sandboxed transient classifier.
    """
    csrf = require_local_origin()
    if csrf is not None:
        return csrf

    body = request.get_json(silent=True) or {}
    console_text = body.get("console_text") or ""
    candidate_yaml = (body.get("candidate_rules_yaml") or "").strip()

    if not console_text:
        return jsonify({"error": "console_text is required"}), 400
    if len(console_text) > _MAX_LOG_BYTES:
        return jsonify({"error": f"console_text exceeds {_MAX_LOG_BYTES} byte cap"}), 400
    if candidate_yaml and len(candidate_yaml) > _MAX_YAML_BYTES:
        return jsonify({"error": f"candidate_rules_yaml exceeds {_MAX_YAML_BYTES} byte cap"}), 400

    # Decide which classifier to use. With no candidate, use the live one
    # the request thread already shares. With a candidate, build a transient
    # classifier in a tmpdir that copies the live rules plus the candidate
    # (a "zz-" prefix file so it sorts last and its priorities can outrank
    # earlier rules if the author intends).
    if not candidate_yaml:
        clf = current_app.classifier
        rule_count = len(clf.rules)
        result = clf.classify(console_text)
        return _result_payload(result, rule_count=rule_count, candidate_used=False)

    try:
        parsed = yaml.safe_load(candidate_yaml)
    except yaml.YAMLError as exc:
        return jsonify({"error": f"Invalid candidate YAML: {exc}"}), 400
    if not isinstance(parsed, dict) or "rules" not in parsed:
        return jsonify({
            "error": "Candidate YAML must be a mapping with a top-level 'rules' list",
        }), 400

    live_rules_dir = _live_rules_dir()
    with tempfile.TemporaryDirectory(prefix="race-sandbox-") as tmp:
        if live_rules_dir and os.path.isdir(live_rules_dir):
            for fname in os.listdir(live_rules_dir):
                if fname.endswith(".yaml"):
                    shutil.copy(os.path.join(live_rules_dir, fname), tmp)
        # zz- prefix makes the candidate sort last — its priorities still
        # decide ordering inside Classifier (priority field, not filename).
        with open(os.path.join(tmp, "zz-sandbox-candidate.yaml"), "w") as f:
            yaml.safe_dump(parsed, f)
        try:
            sandbox_clf = Classifier(rules_path=tmp)
        except Exception as exc:
            return jsonify({"error": f"Candidate rule failed to load: {exc}"}), 400

    rule_count = len(sandbox_clf.rules)
    result = sandbox_clf.classify(console_text)
    return _result_payload(result, rule_count=rule_count, candidate_used=True)


def _result_payload(result, *, rule_count: int, candidate_used: bool):
    """Shape the classifier result into a JSON payload the UI can render in full."""
    if not result or not result.matched_rule_name:
        return jsonify({
            "matched": False,
            "candidate_used": candidate_used,
            "rule_count": rule_count,
            "primary": None,
            "all_labels": [],
            "evidence_snippet": result.evidence_snippet if result else "",
            "evidence_detail": None,
        }), 200

    return jsonify({
        "matched": True,
        "candidate_used": candidate_used,
        "rule_count": rule_count,
        "primary": {
            "label": result.label,
            "rule_name": result.matched_rule_name,
            "domain": result.primary_domain,
            "subcategory": result.subcategory,
            "matched_pattern": result.matched_pattern,
            "impact": result.impact,
            "confidence": (result.confidence.value
                           if hasattr(result.confidence, "value")
                           else str(result.confidence)),
            "action": result.action,
        },
        "all_labels": [l.to_dict() for l in (result.all_labels or [])],
        "secondary_hint": (
            {
                "domain": result.secondary_hint.domain,
                "subcategory": result.secondary_hint.subcategory,
                "rule_name": result.secondary_hint.matched_rule_name,
            }
            if result.secondary_hint else None
        ),
        "evidence_snippet": result.evidence_snippet,
        "evidence_detail": result.evidence_detail,
    }), 200


def _live_rules_dir() -> str:
    """Resolve the live rules directory the same way the app factory does, so sandbox
    classification sees the exact files in use.
    """
    # Mirror application.py: <project>/config/rules
    from pathlib import Path
    return str(Path(__file__).resolve().parents[2] / "config" / "rules")
