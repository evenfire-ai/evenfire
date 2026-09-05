#!/usr/bin/env python3
"""Behavioral contracts for the evidence code executed by the Kubernetes E2E."""

import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "evidence", ROOT / "scripts/e2e/_lib/wrc-networkpolicy-evidence.py"
)
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)
HOLD = "e2e.clerum.io/hold-networkpolicy-delete"
CLEANUP = "clerum.io/workload-cleanup"
STAMP = "2026-09-05T01:02:03Z"


def document(uid, finalizers, timestamp=STAMP, version="42"):
    meta = {"uid": uid, "resourceVersion": version, "finalizers": finalizers}
    if timestamp is not None:
        meta["deletionTimestamp"] = timestamp
    return json.dumps({"metadata": meta})


class EvidenceTests(unittest.TestCase):
    def test_cleanup_signal_requires_exact_recipe_and_current_timestamp(self):
        lines = [
            f'{STAMP} [WR-K8s] Finalizer cleanup failed for "owned": Error: cleanup pending\n',
            f'{STAMP} [WR-K8s] Finalizer cleanup failed for "owned-extra": Error\n',
            '2026-09-04T00:00:00Z [WR-K8s] Finalizer cleanup failed for "owned": Error\n',
            '<no value> [WR-K8s] Finalizer cleanup failed for "owned": Error\n',
            f'{STAMP} [WR-K8s] Finalizer cleanup for "owned"\n',
            f'{STAMP} untrusted data mentions [WR-K8s] Finalizer cleanup failed for "owned":\n',
        ]
        self.assertEqual(evidence.finalizer_failure_count(lines, "owned", STAMP), 1)
        self.assertEqual(evidence.finalizer_failure_count(lines, "foreign", STAMP), 0)

    def test_calendar_and_sentinels(self):
        for value in (STAMP, "2024-02-29T00:00:00.001Z"):
            self.assertTrue(evidence.deletion_timestamp(value))
        for value in (None, "", "null", "<no value>", "2026-02-29T00:00:00Z",
                      "2026-09-05T25:00:00Z", "2026-13-01T00:00:00Z", "garbage"):
            with self.subTest(value=value):
                self.assertFalse(evidence.deletion_timestamp(value))

    def test_barrier_waits_until_both_real_timestamps(self):
        for value in (None, "", "null", "<no value>", "2026-02-30T00:00:00Z"):
            for missing in ("child", "parent"):
                with self.subTest(value=value, missing=missing):
                    self.assertFalse(evidence.barrier_ready(
                        "child", "parent",
                        document("child", [HOLD], value if missing == "child" else STAMP),
                        document("parent", [CLEANUP], value if missing == "parent" else STAMP), HOLD,
                    ))
        self.assertTrue(evidence.barrier_ready(
            "child", "parent", document("child", [HOLD]), document("parent", [CLEANUP]), HOLD,
        ))

    def test_recreated_parent_or_child_cannot_satisfy_barrier(self):
        for child, parent in (("replacement", "parent"), ("child", "replacement")):
            with self.subTest(child=child, parent=parent), self.assertRaises(ValueError):
                evidence.barrier_ready("child", "parent", document(child, [HOLD]),
                                       document(parent, [CLEANUP]), HOLD)

    def test_barrier_requires_both_finalizers(self):
        for child, parent in (([], [CLEANUP]), ([HOLD], [])):
            with self.subTest(child=child, parent=parent), self.assertRaises(ValueError):
                evidence.barrier_ready("child", "parent", document("child", child),
                                       document("parent", parent), HOLD)

    def test_install_preserves_foreign_finalizers_and_tests_uid_version(self):
        patch = evidence.finalizer_patch("install", "child", document("child", ["foreign"], None), HOLD)
        self.assertEqual(patch, [
            {"op": "test", "path": "/metadata/uid", "value": "child"},
            {"op": "test", "path": "/metadata/resourceVersion", "value": "42"},
            {"op": "add", "path": "/metadata/finalizers", "value": ["foreign", HOLD]},
        ])

    def test_release_preserves_finalizers_added_during_deletion(self):
        patch = evidence.finalizer_patch("release", "child", document("child", ["first", HOLD, "new"], version="43"), HOLD)
        self.assertEqual(patch[1]["value"], "43")
        self.assertEqual(patch[2]["value"], ["first", "new"])

    def test_patch_refuses_replacement_and_missing_barrier(self):
        for mode, uid, finalizers, timestamp in (
            ("release", "replacement", [HOLD], STAMP),
            ("release", "child", ["foreign"], STAMP),
            ("release", "child", [HOLD, HOLD], STAMP),
            ("install", "child", [], STAMP),
            ("install", "child", [HOLD], None),
        ):
            with self.subTest(mode=mode, uid=uid, finalizers=finalizers), self.assertRaises(ValueError):
                evidence.finalizer_patch(mode, "child", document(uid, finalizers, timestamp), HOLD)

    def test_malformed_metadata_never_certifies_barrier(self):
        for value in ("{}", "null", "garbage", '{"metadata":null}', '{"metadata":[]}', '{"metadata":{"uid":"child"}}',
                      '{"metadata":{"uid":"child","resourceVersion":"1","finalizers":"bad"}}'):
            with self.subTest(value=value), self.assertRaises((ValueError, KeyError, TypeError)):
                evidence.barrier_ready("child", "parent", value, document("parent", [CLEANUP]), HOLD)


if __name__ == "__main__":
    unittest.main()
