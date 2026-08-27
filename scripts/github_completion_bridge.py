#!/usr/bin/env python3
"""JSON-lines bridge from the DevSpace host to Nexus run_github_completion_loop()."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def _send(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _recv() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("HOST_BRIDGE_EOF")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise RuntimeError("HOST_BRIDGE_RESPONSE_INVALID")
    return value


def main() -> int:
    start = _recv()
    if start.get("type") != "start":
        raise RuntimeError("HOST_BRIDGE_START_MISSING")

    nexus_root = Path(str(start["nexus_root"])).resolve()
    if not (nexus_root / "nexus" / "orchestrator" / "github_completion_loop.py").is_file():
        raise RuntimeError("NEXUS_COMPLETION_CALLER_MISSING")
    sys.path.insert(0, str(nexus_root))

    from nexus.contracts.github_orchestration import (  # noqa: PLC0415
        CheckResult,
        GitHubOrchestrationEvidence,
        ReviewResult,
    )
    from nexus.orchestrator.autonomy_policy import StandingGrantRequest  # noqa: PLC0415
    from nexus.orchestrator.github_completion_loop import (  # noqa: PLC0415
        CasMergeResult,
        CasMergeStatus,
        DimensionRevalidationReceipt,
        IntegrationMaterializationResult,
        PostMergeReconciliationResult,
        make_dimension_revalidation_receipt,
        run_github_completion_loop,
    )

    class HostPort:
        def __init__(self) -> None:
            self._next_id = 1

        def _call(self, method: str, params: dict[str, Any] | None = None) -> Any:
            call_id = self._next_id
            self._next_id += 1
            _send({"type": "call", "id": call_id, "method": method, "params": params or {}})
            response = _recv()
            if response.get("type") != "result" or response.get("id") != call_id:
                raise RuntimeError(f"HOST_BRIDGE_RESPONSE_MISMATCH:{method}")
            if response.get("ok") is not True:
                raise RuntimeError(f"HOST_PORT_{method}:{response.get('error', 'unknown')}")
            return response.get("result")

        def read_main_state(self) -> tuple[str, str]:
            result = self._call("read_main_state")
            return str(result["commit_sha"]), str(result["tree_sha"])

        def get_tree_sha(self, commit_sha: str) -> str:
            return str(self._call("get_tree_sha", {"commit_sha": commit_sha})["tree_sha"])

        def read_pr_head_sha(self) -> str:
            return str(self._call("read_pr_head_sha")["head_sha"])

        def read_blob_sha(self, commit_or_tree_sha: str, path: str) -> str:
            return str(
                self._call(
                    "read_blob_sha",
                    {"commit_or_tree_sha": commit_or_tree_sha, "path": path},
                )["blob_sha"]
            )

        def get_changed_main_paths(self, old_main_sha: str, new_main_sha: str) -> tuple[str, ...]:
            result = self._call(
                "get_changed_main_paths",
                {"old_main_sha": old_main_sha, "new_main_sha": new_main_sha},
            )
            return tuple(str(path) for path in result["paths"])

        def revalidate_affected_dimension(self, dimension, *, evidence, movement, generation):
            result = self._call(
                "revalidate_affected_dimension",
                {
                    "dimension": dimension,
                    "generation": generation,
                    "old_main_sha": movement.old_main_sha,
                    "new_main_sha": movement.new_main_sha,
                    "source_candidate_commit_sha": movement.candidate_head_sha,
                    "source_candidate_tree_sha": movement.candidate_tree_sha,
                },
            )
            receipt = make_dimension_revalidation_receipt(
                dimension=dimension,
                generation=generation,
                old_main_sha=movement.old_main_sha,
                new_main_sha=movement.new_main_sha,
                source_candidate_commit_sha=movement.candidate_head_sha,
                source_candidate_tree_sha=movement.candidate_tree_sha,
                passed=bool(result.get("passed", False)),
                requires_fresh_candidate_acceptance=bool(
                    result.get("requires_fresh_candidate_acceptance", False)
                ),
                details=result.get("details") if isinstance(result.get("details"), dict) else {},
            )
            return DimensionRevalidationReceipt.model_validate(receipt.model_dump(mode="json"))

        def materialize_integration_head(
            self,
            *,
            base_sha,
            base_tree_sha,
            expected_pr_head_sha,
            candidate_tree_sha,
            generation,
        ):
            result = self._call(
                "materialize_integration_head",
                {
                    "base_sha": base_sha,
                    "base_tree_sha": base_tree_sha,
                    "expected_pr_head_sha": expected_pr_head_sha,
                    "candidate_tree_sha": candidate_tree_sha,
                    "generation": generation,
                },
            )
            return IntegrationMaterializationResult.model_validate(result)

        def read_required_checks(self, *, head_sha, generation, timeout_seconds=None):
            result = self._call(
                "read_required_checks",
                {
                    "head_sha": head_sha,
                    "generation": generation,
                    "timeout_seconds": timeout_seconds,
                },
            )
            return tuple(CheckResult.model_validate(item) for item in result["checks"])

        def read_reviews(self):
            result = self._call("read_reviews")
            unresolved = int(result.get("unresolved_threads", 0))
            if unresolved:
                raise RuntimeError(f"UNRESOLVED_REVIEW_THREADS:{unresolved}")
            return tuple(ReviewResult.model_validate(item) for item in result.get("reviews", []))

        def is_platform_approval_required(self, *, repository, pull_request_number):
            result = self._call(
                "is_platform_approval_required",
                {"repository": repository, "pull_request_number": pull_request_number},
            )
            return bool(result["required"])

        def cas_merge(self, *, repository, pull_request_number, expected_base_sha, expected_head_sha):
            result = self._call(
                "cas_merge",
                {
                    "repository": repository,
                    "pull_request_number": pull_request_number,
                    "expected_base_sha": expected_base_sha,
                    "expected_head_sha": expected_head_sha,
                },
            )
            return CasMergeResult(
                status=CasMergeStatus(str(result["status"])),
                merged_sha=result.get("merged_sha"),
                reason=result.get("reason"),
            )

        def reconcile_post_merge(
            self, *, repository, pull_request_number, expected_base_sha, expected_head_sha
        ):
            result = self._call(
                "reconcile_post_merge",
                {
                    "repository": repository,
                    "pull_request_number": pull_request_number,
                    "expected_base_sha": expected_base_sha,
                    "expected_head_sha": expected_head_sha,
                },
            )
            return PostMergeReconciliationResult.model_validate(result)

    evidence = GitHubOrchestrationEvidence.model_validate(start["initial_evidence"])
    request = StandingGrantRequest.model_validate(start["standing_grant_request"])
    result = run_github_completion_loop(
        initial_evidence=evidence,
        request=request,
        port=HostPort(),
        max_generations=int(start.get("max_generations", 3)),
        max_elapsed_seconds=float(start.get("max_elapsed_seconds", 2700.0)),
        git_root=nexus_root,
    )
    payload = {
        "outcome": result.outcome.value,
        "reason": result.reason,
        "generation": result.generation,
        "integration_head_sha": result.integration_head_sha,
        "merged_commit_sha": result.merged_commit_sha,
        "evidence": result.evidence.model_dump(mode="json") if result.evidence else None,
        "intent": result.intent.model_dump(mode="json") if result.intent else None,
        "details": result.details,
    }
    _send({"type": "done", "result": payload})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # fail closed across the language boundary
        _send({"type": "fatal", "error": f"{type(exc).__name__}:{exc}"})
        raise
