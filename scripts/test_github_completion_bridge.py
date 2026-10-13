#!/usr/bin/env python3
"""Unit tests for parse_head_check_runs in github_completion_bridge.py (Nexus-new #2068)."""

import importlib.util
import os
import sys
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "github_completion_bridge", Path(__file__).with_name("github_completion_bridge.py")
)
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)

SHA = "a" * 40


class Obs:
    def __init__(self, *, name, status, conclusion, head_sha, app_id, workflow_path):
        self.name, self.status, self.conclusion, self.head_sha = name, status, conclusion, head_sha
        self.app_id, self.workflow_path = app_id, workflow_path


def run(**over):
    base = {"name": "Exact-base impact gate", "status": "completed", "conclusion": "success",
            "head_sha": SHA, "app_slug": "github-actions", "app_id": 15368,
            "workflow_path": ".github/workflows/pytest.yml"}
    base.update(over)
    return base


class ParseHeadCheckRuns(unittest.TestCase):
    def parse(self, result, sha=SHA):
        return bridge.parse_head_check_runs(result, sha, Obs)

    def test_valid_runs(self):
        out = self.parse({"check_runs": [run(), run(name="x", conclusion=None, status="queued")]})
        self.assertEqual([o.name for o in out], ["Exact-base impact gate", "x"])
        self.assertIsNone(out[1].conclusion)
        self.assertEqual(out[0].app_id, 15368)
        self.assertEqual(out[0].workflow_path, ".github/workflows/pytest.yml")

    def test_non_actions_app_has_empty_workflow_path(self):
        out = self.parse({"check_runs": [run(app_id=7, workflow_path="")]})
        self.assertEqual((out[0].app_id, out[0].workflow_path), (7, ""))

    def test_missing_or_bad_app_fields_fail_closed(self):
        for bad in [{"app_id": None}, {"app_id": "1"}, {"app_id": True}, {"workflow_path": None}, {"workflow_path": 3}]:
            with self.assertRaises(RuntimeError):
                self.parse({"check_runs": [run(**bad)]})

    def test_empty_ok_when_host_says_empty(self):
        self.assertEqual(self.parse({"check_runs": []}), ())

    def test_bad_requested_sha(self):
        for bad in ["abc", "A" * 40, None]:
            with self.assertRaises(RuntimeError):
                self.parse({"check_runs": []}, bad)

    def test_mismatched_run_sha(self):
        with self.assertRaises(RuntimeError):
            self.parse({"check_runs": [run(head_sha="b" * 40)]})

    def test_malformed_payload(self):
        for bad in [None, [], {}, {"check_runs": None}, {"check_runs": ["x"]}]:
            with self.assertRaises(RuntimeError):
                self.parse(bad)


def _load_real_observation():
    """Import the real HeadCheckRunObservation from a Nexus-new checkout.

    Root: $NEXUS_NEW_ROOT or ~/workspace/Nexus-new. Returns (cls, None) or
    (None, reason) when it cannot be imported (the contract test then skips).
    """
    root = Path(os.environ.get("NEXUS_NEW_ROOT", Path.home() / "workspace" / "Nexus-new"))
    if not (root / "nexus" / "orchestrator" / "github_completion_loop.py").is_file():
        return None, f"no Nexus-new checkout at {root}"
    sys.path.insert(0, str(root))
    try:
        from nexus.orchestrator.github_completion_loop import HeadCheckRunObservation  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001 - any import failure means skip
        return None, f"cannot import HeadCheckRunObservation from {root}: {type(exc).__name__}: {exc}"
    return HeadCheckRunObservation, None


REAL_OBS, REAL_SKIP_REASON = _load_real_observation()


class RealModelContract(unittest.TestCase):
    """Feeds host-shaped payloads through the REAL Nexus-new model (no fake)."""

    def setUp(self):
        if REAL_OBS is None:
            print(f"SKIP RealModelContract: {REAL_SKIP_REASON}", file=sys.stderr)
            self.skipTest(REAL_SKIP_REASON)

    def test_realistic_mix_validates_with_real_model(self):
        payload = {"check_runs": [
            run(name="Exact-base impact gate", workflow_path=".github/workflows/pytest.yml"),
            run(name="Trusted impact gate (default branch)",
                workflow_path=".github/workflows/trusted-impact-gate.yml"),
            run(name="third-party-scan", app_id=7, app_slug="other-app", workflow_path=""),
        ]}
        out = bridge.parse_head_check_runs(payload, SHA, REAL_OBS)
        self.assertEqual([o.app_id for o in out], [15368, 15368, 7])
        self.assertEqual(
            [o.workflow_path for o in out],
            [".github/workflows/pytest.yml", ".github/workflows/trusted-impact-gate.yml", ""],
        )


if __name__ == "__main__":
    unittest.main()
