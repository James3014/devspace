#!/usr/bin/env python3
"""Consume one exact-head Repository Intelligence GitHub Actions artifact.

GitHub is transport only. Canonical bundle verification is delegated to the
configured Repository Intelligence checkout through adapters.github_action.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Callable, Mapping, Sequence
from typing import Any

API_ROOT = "https://api.github.com"
ARTIFACT_PREFIX = "repository-intelligence-pr-"
REPORT_NAME = "repository-intelligence.json"
MAX_API_BYTES = 4 * 1024 * 1024
MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
MAX_REPORT_BYTES = 4 * 1024 * 1024
CLAIM_CEILING = "ADVISORY_EVIDENCE_ONLY"
SNAPSHOT_SEMANTICS = "PR_EVENT_SNAPSHOT_NOT_TERMINAL_CI"


class ArtifactConsumerError(RuntimeError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


def _validate_repository(value: str) -> str:
    parts = value.split("/")
    if len(parts) != 2 or any(not part or part in {".", ".."} for part in parts):
        raise ArtifactConsumerError("repository must be owner/name")
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
    if any(any(char not in allowed for char in part) for part in parts):
        raise ArtifactConsumerError("repository contains unsupported characters")
    return value


def _validate_head(value: str) -> str:
    normalized = value.strip().lower()
    if len(normalized) != 40 or any(char not in "0123456789abcdef" for char in normalized):
        raise ArtifactConsumerError("expected head must be a full 40-hex SHA")
    return normalized


def _headers(*, include_auth: bool) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "devspace-rie-artifact-consumer",
    }
    if include_auth:
        token = (
            os.environ.get("DEVSPACE_GITHUB_TOKEN")
            or os.environ.get("GITHUB_TOKEN")
            or os.environ.get("GH_TOKEN")
        )
        if token:
            headers["Authorization"] = f"Bearer {token}"
    return headers


def _read_bounded(response: Any, limit: int) -> bytes:
    content_length = response.headers.get("Content-Length")
    if content_length:
        try:
            if int(content_length) > limit:
                raise ArtifactConsumerError(f"response exceeded {limit} byte limit")
        except ValueError:
            pass
    raw = response.read(limit + 1)
    if len(raw) > limit:
        raise ArtifactConsumerError(f"response exceeded {limit} byte limit")
    return raw


def _api_json(path: str) -> Any:
    if not path.startswith("/") or path.startswith("//"):
        raise ArtifactConsumerError("GitHub API path must be host-relative")
    request = urllib.request.Request(
        f"{API_ROOT}{path}",
        headers=_headers(include_auth=True),
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = _read_bounded(response, MAX_API_BYTES)
    except urllib.error.HTTPError as exc:
        detail = exc.read(8192).decode("utf-8", errors="replace").strip()
        raise ArtifactConsumerError(
            f"GitHub HTTP {exc.code}: {detail or exc.reason}"
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ArtifactConsumerError(f"GitHub read failed: {exc}") from exc
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ArtifactConsumerError("GitHub returned invalid JSON") from exc


def _select_artifact(
    artifacts: Sequence[Mapping[str, Any]],
    expected_name: str,
    expected_head: str,
) -> Mapping[str, Any]:
    candidates: list[Mapping[str, Any]] = []
    for artifact in artifacts:
        if artifact.get("name") != expected_name or artifact.get("expired") is True:
            continue
        run = artifact.get("workflow_run")
        if isinstance(run, Mapping):
            run_head = run.get("head_sha")
            if isinstance(run_head, str) and run_head.lower() != expected_head:
                continue
        candidates.append(artifact)
    if not candidates:
        raise ArtifactConsumerError("exact-head Repository Intelligence artifact not found")
    if len(candidates) != 1:
        raise ArtifactConsumerError("exact-head Repository Intelligence artifact is ambiguous")
    artifact = candidates[0]
    artifact_id = artifact.get("id")
    if not isinstance(artifact_id, int) or artifact_id <= 0:
        raise ArtifactConsumerError("artifact id is missing or invalid")
    return artifact


def _artifact_metadata(repository: str, pr_number: int, expected_head: str) -> Mapping[str, Any]:
    expected_name = f"{ARTIFACT_PREFIX}{pr_number}-{expected_head}"
    owner, repo = repository.split("/", 1)
    query = urllib.parse.urlencode({"name": expected_name, "per_page": 100})
    payload = _api_json(f"/repos/{owner}/{repo}/actions/artifacts?{query}")
    if not isinstance(payload, Mapping):
        raise ArtifactConsumerError("GitHub artifact list response is invalid")
    rows = payload.get("artifacts")
    if not isinstance(rows, list) or any(not isinstance(row, Mapping) for row in rows):
        raise ArtifactConsumerError("GitHub artifact list is invalid")
    total_count = payload.get("total_count")
    if isinstance(total_count, int) and total_count > len(rows):
        raise ArtifactConsumerError("GitHub artifact result exceeded one-page bounded search")
    return _select_artifact(rows, expected_name, expected_head)


def _validate_redirect(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ArtifactConsumerError("GitHub artifact redirect was not a safe HTTPS URL")
    hostname = parsed.hostname.lower()
    if hostname in {"localhost", "127.0.0.1", "::1"} or hostname.endswith(".local"):
        raise ArtifactConsumerError("GitHub artifact redirect resolved to a forbidden host name")
    return url


def _download_archive(repository: str, artifact_id: int) -> bytes:
    owner, repo = repository.split("/", 1)
    url = f"{API_ROOT}/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip"
    request = urllib.request.Request(url, headers=_headers(include_auth=True), method="GET")
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        opener.open(request, timeout=20)
        raise ArtifactConsumerError("GitHub artifact endpoint did not return a redirect")
    except urllib.error.HTTPError as exc:
        if exc.code not in {301, 302, 303, 307, 308}:
            detail = exc.read(8192).decode("utf-8", errors="replace").strip()
            raise ArtifactConsumerError(
                f"GitHub artifact download HTTP {exc.code}: {detail or exc.reason}"
            ) from exc
        location = exc.headers.get("Location")
        if not location:
            raise ArtifactConsumerError("GitHub artifact redirect did not include Location") from exc
    signed_url = _validate_redirect(urllib.parse.urljoin(url, location))
    # Never forward the GitHub bearer token to the signed artifact host.
    signed_request = urllib.request.Request(
        signed_url,
        headers={"User-Agent": "devspace-rie-artifact-consumer"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(signed_request, timeout=30) as response:
            return _read_bounded(response, MAX_ARCHIVE_BYTES)
    except urllib.error.HTTPError as exc:
        detail = exc.read(8192).decode("utf-8", errors="replace").strip()
        raise ArtifactConsumerError(
            f"GitHub signed artifact download HTTP {exc.code}: {detail or exc.reason}"
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ArtifactConsumerError(f"GitHub artifact download failed: {exc}") from exc


def _extract_report(archive: bytes) -> Mapping[str, Any]:
    if len(archive) > MAX_ARCHIVE_BYTES:
        raise ArtifactConsumerError("artifact archive exceeded bounded size")
    try:
        with zipfile.ZipFile(io.BytesIO(archive), "r") as zipped:
            infos = zipped.infolist()
            if len(infos) != 1:
                raise ArtifactConsumerError("artifact archive must contain exactly one report file")
            info = infos[0]
            if info.is_dir() or info.filename != REPORT_NAME:
                raise ArtifactConsumerError("artifact archive contains an unexpected path")
            unix_mode = (info.external_attr >> 16) & 0o170000
            if unix_mode == 0o120000:
                raise ArtifactConsumerError("artifact report may not be a symbolic link")
            if info.file_size > MAX_REPORT_BYTES:
                raise ArtifactConsumerError("artifact report exceeded bounded size")
            raw = zipped.read(info)
    except ArtifactConsumerError:
        raise
    except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
        raise ArtifactConsumerError(f"artifact archive is invalid: {exc}") from exc
    if len(raw) > MAX_REPORT_BYTES:
        raise ArtifactConsumerError("artifact report exceeded bounded size")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ArtifactConsumerError("artifact report is not valid UTF-8 JSON") from exc
    if not isinstance(payload, Mapping):
        raise ArtifactConsumerError("artifact report must be a JSON object")
    return payload


def _validate_bundle(
    payload: Mapping[str, Any],
    repository: str,
    pr_number: int,
    expected_head: str,
    verifier: Callable[[Mapping[str, Any]], bool],
) -> list[Any]:
    if not verifier(payload):
        raise ArtifactConsumerError("canonical Repository Intelligence bundle verification failed")
    if payload.get("claim_ceiling") != CLAIM_CEILING:
        raise ArtifactConsumerError("Repository Intelligence claim ceiling is not advisory-only")
    identity = payload.get("review_identity")
    if not isinstance(identity, list) or len(identity) != 5:
        raise ArtifactConsumerError("Repository Intelligence review identity is invalid")
    if identity[0] != repository or identity[1] != pr_number or identity[2] != expected_head:
        raise ArtifactConsumerError("Repository Intelligence review identity mismatches requested subject")
    return identity


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _report_value(payload: Mapping[str, Any], report: str, field: str) -> str | None:
    reports = payload.get("reports")
    if not isinstance(reports, Mapping):
        return None
    envelope = reports.get(report)
    if not isinstance(envelope, Mapping):
        return None
    result = envelope.get("result")
    if not isinstance(result, Mapping):
        return None
    return _optional_string(result.get(field))


def consume(repository: str, pr_number: int, expected_head: str) -> dict[str, Any]:
    repository = _validate_repository(repository)
    if not isinstance(pr_number, int) or pr_number <= 0:
        raise ArtifactConsumerError("pr-number must be a positive integer")
    expected_head = _validate_head(expected_head)

    artifact = _artifact_metadata(repository, pr_number, expected_head)
    archive = _download_archive(repository, int(artifact["id"]))
    digest = f"sha256:{hashlib.sha256(archive).hexdigest()}"
    advertised_digest = artifact.get("digest")
    if isinstance(advertised_digest, str) and advertised_digest and advertised_digest != digest:
        raise ArtifactConsumerError("artifact ZIP digest mismatches GitHub metadata")
    payload = _extract_report(archive)

    try:
        from adapters.github_action import verify_cloud_bundle
    except Exception as exc:  # pragma: no cover - exact RIE checkout wiring
        raise ArtifactConsumerError(f"canonical Repository Intelligence verifier unavailable: {exc}") from exc

    identity = _validate_bundle(
        payload,
        repository,
        pr_number,
        expected_head,
        verify_cloud_bundle,
    )
    run = artifact.get("workflow_run")
    run_id = run.get("id") if isinstance(run, Mapping) else None
    return {
        "schema": "devspace.repository_intelligence_artifact.v1",
        "repository": repository,
        "prNumber": pr_number,
        "expectedHead": expected_head,
        "artifactId": int(artifact["id"]),
        "artifactName": str(artifact.get("name") or ""),
        "artifactDigest": digest,
        "workflowRunId": run_id if isinstance(run_id, int) else None,
        "reviewIdentity": identity,
        "contentSha256": str(payload.get("content_sha256") or ""),
        "claimCeiling": CLAIM_CEILING,
        "readiness": _report_value(payload, "readiness", "disposition"),
        "cfiStatus": _report_value(payload, "cfi", "status"),
        "eiaDecision": _report_value(payload, "eia", "decision"),
        "snapshotSemantics": SNAPSHOT_SEMANTICS,
    }


def _zip_bytes(name: str, content: bytes) -> bytes:
    target = io.BytesIO()
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
        zipped.writestr(name, content)
    return target.getvalue()


def _self_test() -> None:
    head = "a" * 40
    name = f"{ARTIFACT_PREFIX}7-{head}"
    good = {"id": 1, "name": name, "expired": False, "workflow_run": {"head_sha": head}}
    assert _select_artifact([good], name, head)["id"] == 1
    try:
        _select_artifact([], name, head)
        raise AssertionError("missing artifact should fail")
    except ArtifactConsumerError:
        pass
    try:
        _select_artifact([good, dict(good, id=2)], name, head)
        raise AssertionError("ambiguous artifact should fail")
    except ArtifactConsumerError:
        pass
    payload = {
        "claim_ceiling": CLAIM_CEILING,
        "review_identity": ["owner/repo", 7, head, "b" * 40, "b" * 40],
    }
    archive = _zip_bytes(REPORT_NAME, json.dumps(payload).encode())
    extracted = _extract_report(archive)
    assert extracted["review_identity"][2] == head
    assert _validate_bundle(extracted, "owner/repo", 7, head, lambda _: True)[2] == head
    try:
        _validate_bundle(extracted, "owner/repo", 7, "c" * 40, lambda _: True)
        raise AssertionError("identity mismatch should fail")
    except ArtifactConsumerError:
        pass
    try:
        _validate_bundle(extracted, "owner/repo", 7, head, lambda _: False)
        raise AssertionError("invalid canonical bundle should fail")
    except ArtifactConsumerError:
        pass
    try:
        _extract_report(_zip_bytes("../repository-intelligence.json", b"{}"))
        raise AssertionError("unsafe archive path should fail")
    except ArtifactConsumerError:
        pass
    oversized = b"x" * (MAX_REPORT_BYTES + 1)
    try:
        _extract_report(_zip_bytes(REPORT_NAME, oversized))
        raise AssertionError("oversized report should fail")
    except ArtifactConsumerError:
        pass
    print("ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository")
    parser.add_argument("--pr-number", type=int)
    parser.add_argument("--expected-head")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        _self_test()
        return 0
    if not args.repository or not args.pr_number or not args.expected_head:
        parser.error("--repository, --pr-number and --expected-head are required")
    try:
        result = consume(args.repository, args.pr_number, args.expected_head)
    except ArtifactConsumerError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
