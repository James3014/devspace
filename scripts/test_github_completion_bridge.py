#!/usr/bin/env python3
"""Unit tests for parse_head_check_runs in github_completion_bridge.py (Nexus-new #2068)."""

import importlib.util
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "github_completion_bridge", Path(__file__).with_name("github_completion_bridge.py")
)
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)

SHA = "a" * 40


class Obs:
    def __init__(self, *, name, status, conclusion, head_sha):
        self.name, self.status, self.conclusion, self.head_sha = name, status, conclusion, head_sha


def run(**over):
    base = {"name": "Exact-base impact gate", "status": "completed", "conclusion": "success",
            "head_sha": SHA, "app_slug": "github-actions", "app_id": 15368}
    base.update(over)
    return base


class ParseHeadCheckRuns(unittest.TestCase):
    def parse(self, result, sha=SHA):
        return bridge.parse_head_check_runs(result, sha, Obs)

    def test_valid_runs(self):
        out = self.parse({"check_runs": [run(), run(name="x", conclusion=None, status="queued")]})
        self.assertEqual([o.name for o in out], ["Exact-base impact gate", "x"])
        self.assertIsNone(out[1].conclusion)

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


if __name__ == "__main__":
    unittest.main()
