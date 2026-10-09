#!/usr/bin/env python3
"""E2E_GUARDIAN_STRICT_NETWORK opt-in of tools/e2e_static_audit.py (#1044).

A file that declares the marker also fails on page.route(, context.route( and
force: true. A file without the marker is audited exactly as before, so the
existing Codex lane keeps passing.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
AUDIT = ROOT / "tools" / "e2e_static_audit.py"
SPEC = importlib.util.spec_from_file_location("e2e_static_audit", AUDIT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {AUDIT}")
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)

HEADER = "/** E2E_GUARDIAN_IPC_FLOW: Desktop uses real main-process IPC. */\n"
STRICT_HEADER = HEADER + "// E2E_GUARDIAN_STRICT_NETWORK: no interception, no forced actions.\n"
CLEAN_BODY = (
    "test('journey', async ({ page }) => {\n"
    "  await page.getByRole('button', { name: 'Retry model step' }).click()\n"
    "})\n"
)
VIOLATIONS = {
    "page.route": "  await page.route('**/api/**', route => route.continue())\n",
    "context.route": "  await context.route('**/rpc/**', route => route.abort())\n",
    "force": "  await page.getByTestId('send-button').click({ force: true })\n",
}


class StrictNetworkAuditTest(unittest.TestCase):
    def audit_text(self, text: str) -> list[str]:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "journey.spec.ts"
            path.write_text(text, encoding="utf-8")
            return audit.audit_file(path)

    def test_clean_strict_file_passes(self) -> None:
        self.assertEqual(self.audit_text(STRICT_HEADER + CLEAN_BODY), [])

    def test_strict_file_rejects_each_violation(self) -> None:
        for name, line in VIOLATIONS.items():
            with self.subTest(violation=name):
                findings = self.audit_text(STRICT_HEADER + CLEAN_BODY + line)
                self.assertEqual(len(findings), 1, findings)
                self.assertIn("strict-network file", findings[0])
                # Two header lines and three body lines: the violation is line 6.
                self.assertIn(":6:", findings[0])

    def test_unmarked_file_keeps_the_previous_rules(self) -> None:
        for name, line in VIOLATIONS.items():
            with self.subTest(violation=name):
                # Witness: the same unmarked file still fails a base rule.
                self.assertEqual(
                    [finding.split(": ", 1)[1] for finding in self.audit_text(
                        HEADER + CLEAN_BODY + line + "  await page.waitForTimeout(10)\n"
                    )],
                    ["fixed sleep"],
                )
                self.assertEqual(self.audit_text(HEADER + CLEAN_BODY + line), [])


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    if result.testsRun == 0:
        print("no tests ran", file=sys.stderr)
        raise SystemExit(1)
    raise SystemExit(0 if result.wasSuccessful() else 1)
