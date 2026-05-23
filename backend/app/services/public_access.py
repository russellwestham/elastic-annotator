from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from typing import Any

PUBLIC_MATCH_IDS = {"J03WN1", "J03WMX", "J03WPY"}
PUBLIC_ANNOTATOR_ALIASES = {
    "hyunsung": "annot1",
    "hoyoung": "annot2",
    "kunhee": "annot3",
}
PUBLIC_ALIAS_TO_ANNOTATOR = {alias: annotator for annotator, alias in PUBLIC_ANNOTATOR_ALIASES.items()}


def normalize_public_identity(value: str | None) -> str:
    text = (value or "").strip().lower()
    text = re.sub(r"\s*\(auto\)\s*$", "", text)
    return text


def public_baseline_annotator(metadata: dict[str, Any]) -> str | None:
    match_id = str(metadata.get("match_id") or "").strip()
    if match_id not in PUBLIC_MATCH_IDS:
        return None

    session_name = normalize_public_identity(metadata.get("session_name"))
    annotator_name = normalize_public_identity(metadata.get("annotator_name"))
    if session_name:
        candidates = [session_name]
    elif metadata.get("session_mode") == "upload_csv":
        candidates = [annotator_name]
    else:
        return None
    for candidate in candidates:
        if not candidate:
            continue
        for annotator in PUBLIC_ANNOTATOR_ALIASES:
            if candidate == annotator or candidate.endswith(f"_{annotator}"):
                return annotator
        for alias, annotator in PUBLIC_ALIAS_TO_ANNOTATOR.items():
            if candidate == alias or candidate.endswith(f"_{alias}"):
                return annotator
    return None


def is_public_baseline_session(metadata: dict[str, Any]) -> bool:
    return public_baseline_annotator(metadata) is not None


def public_display_name(metadata: dict[str, Any]) -> str:
    annotator = public_baseline_annotator(metadata)
    if annotator is not None:
        alias = PUBLIC_ANNOTATOR_ALIASES[annotator]
        match_id = str(metadata.get("match_id") or "").strip()
        return f"{match_id}_{alias}"

    return (
        str(metadata.get("session_name") or "").strip()
        or str(metadata.get("original_video_filename") or "").strip()
        or str(metadata.get("match_id") or "").strip()
        or str(metadata.get("session_id") or "").strip()
        or "Session"
    )


def mask_public_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    masked = dict(metadata)
    masked["dataset_root"] = ""
    annotator = public_baseline_annotator(metadata)
    if annotator is not None:
        alias = PUBLIC_ANNOTATOR_ALIASES[annotator]
        display_name = public_display_name(metadata)
        masked["annotator_name"] = alias
        masked["session_name"] = display_name
        masked["display_name"] = display_name
        masked["public_baseline"] = True
        masked["public_read_only"] = True
        masked["public_editable"] = False
        masked["public_source"] = "baseline"
        return masked

    display_name = public_display_name(metadata)
    public_created = bool(metadata.get("public_created", False))
    masked["display_name"] = display_name
    masked["public_baseline"] = False
    masked["public_read_only"] = public_created
    masked["public_editable"] = False
    masked["public_source"] = "created" if public_created else None
    return masked


def is_public_visible_session(metadata: dict[str, Any]) -> bool:
    return is_public_baseline_session(metadata) or bool(metadata.get("public_created", False))


def generate_edit_token() -> str:
    return secrets.token_urlsafe(32)


def hash_edit_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_edit_token(metadata: dict[str, Any], token: str | None) -> bool:
    expected = str(metadata.get("edit_token_hash") or "")
    if not expected or not token:
        return False
    return hmac.compare_digest(expected, hash_edit_token(token))


def apply_public_edit_state(metadata: dict[str, Any], token: str | None) -> dict[str, Any]:
    masked = mask_public_metadata(metadata)
    if masked.get("public_baseline"):
        return masked

    if bool(metadata.get("public_created", False)) and verify_edit_token(metadata, token):
        masked["public_read_only"] = False
        masked["public_editable"] = True
    return masked
