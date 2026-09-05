#!/usr/bin/env python3
"""Regression coverage for browser versus operational E2E audit boundaries."""

from pathlib import Path
import tempfile
import unittest

from e2e_static_audit import audit_file


class StaticAuditTests(unittest.TestCase):
    def audit(self, name, source):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / name
            path.write_text(source, encoding="utf-8")
            return audit_file(path)

    def test_operational_journey_does_not_require_browser_requests(self):
        self.assertEqual(self.audit("journey.sh", "wait_for_resource_absent networkpolicy ns name 90\n"), [])

    def test_browser_variants_still_require_network_evidence(self):
        for suffix in ("js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"):
            with self.subTest(suffix=suffix):
                findings = self.audit(f"journey.spec.{suffix}", "await page.getByRole('button').click();\n")
                self.assertTrue(any("missing critical network" in finding for finding in findings))

    def test_browser_navigation_guard_is_not_weakened(self):
        findings = self.audit("journey.spec.ts", "await page.goto('/done');\nawait page.waitForResponse('/done');\n")
        self.assertTrue(any("direct page.goto" in finding for finding in findings))

    def test_shell_suffix_does_not_bypass_general_rules(self):
        findings = self.audit("journey.sh", "localStorage.setItem('state', 'done')\n")
        self.assertTrue(any("browser storage/session mutation" in finding for finding in findings))


if __name__ == "__main__":
    unittest.main()
