#!/usr/bin/env python3
"""Cluster-free unit tests for the E2E Guardian source audit."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("e2e_static_audit", ROOT / "e2e_static_audit.py")
assert SPEC and SPEC.loader
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class E2EStaticAuditTests(unittest.TestCase):
    def audit(self, source: str, relative_path: str = "fixture.test.ts") -> list[str]:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(source, encoding="utf-8")
            return AUDIT.audit_file(path)

    def test_fixed_set_timeout_is_rejected(self) -> None:
        findings = self.audit("setTimeout(() => resolve(), 5000)\nfetch('/health')\n")
        self.assertTrue(any("fixed sleep" in finding for finding in findings))

    def test_polling_interval_variable_is_not_rejected_as_fixed_sleep(self) -> None:
        findings = self.audit(
            "const intervalMs = 5000\nsetTimeout(() => poll(), intervalMs)\nfetch('/health')\n"
        )
        self.assertFalse(any("fixed sleep" in finding for finding in findings))

    def test_refetch_is_not_treated_as_a_network_wait(self) -> None:
        findings = self.audit("await refetch()\n")
        self.assertTrue(any("missing critical network-response/request wait" in finding for finding in findings))

    def test_fetch_does_not_exempt_a_playwright_browser_spec(self) -> None:
        findings = self.audit(
            "import { test } from '@playwright/test'\n"
            "test('journey', async ({ page }) => {\n"
            "  await fetch('/health')\n"
            "  await page.getByRole('button', { name: 'Save' }).click()\n"
            "})\n"
        )
        self.assertTrue(any("missing critical network-response/request wait" in finding for finding in findings))

    def test_fetch_exempts_a_non_browser_http_integration(self) -> None:
        findings = self.audit(
            "import { test } from 'vitest'\n"
            "test('health contract', async () => { await fetch('/health') })\n"
        )
        self.assertFalse(any("missing critical network-response/request wait" in finding for finding in findings))

    def test_fetch_does_not_exempt_a_custom_playwright_page_fixture(self) -> None:
        findings = self.audit(
            "test('journey', async ({ authedPage }) => {\n"
            "  await fetch('/health')\n"
            "  await authedPage.getByRole('button', { name: 'Save' }).click()\n"
            "})\n"
        )
        self.assertTrue(any("missing critical network-response/request wait" in finding for finding in findings))

    def test_e2e_playwright_path_classifies_a_custom_keyboard_fixture(self) -> None:
        findings = self.audit(
            "test('journey', async ({ desktopWindow }) => {\n"
            "  await fetch('/health')\n"
            "  await desktopWindow.keyboard.press('Enter')\n"
            "})\n",
            "desktop-app/test/e2e-playwright/keyboard.test.ts",
        )
        self.assertTrue(any("missing critical network-response/request wait" in finding for finding in findings))

    def test_documented_ipc_flow_comment_exempts_browser_network_wait(self) -> None:
        findings = self.audit(
            "/*\n"
            " * E2E_GUARDIAN_IPC_FLOW: discovery uses a visible main-process IPC bridge.\n"
            " */\n"
            "await page.getByRole('button', { name: 'Files' }).click()\n"
        )
        self.assertFalse(any("missing critical network-response/request wait" in finding for finding in findings))

    def test_ipc_flow_marker_in_a_string_does_not_exempt_browser_wait(self) -> None:
        findings = self.audit(
            "const marker = 'E2E_GUARDIAN_IPC_FLOW'\n"
            "await page.getByRole('button', { name: 'Files' }).click()\n"
        )
        self.assertTrue(any("missing critical network-response/request wait" in finding for finding in findings))

    def test_ipc_flow_marker_does_not_exempt_a_non_browser_spec(self) -> None:
        findings = self.audit(
            "// E2E_GUARDIAN_IPC_FLOW: not a browser journey.\n"
            "const value = 1\n"
        )
        self.assertTrue(any("missing critical network-response/request wait" in finding for finding in findings))

    def test_comments_do_not_trigger_rules_or_network_wait_detection(self) -> None:
        findings = self.audit(
            "// waitForTimeout(5000), fetch('/health'), and page.goto('/bad')\n"
            "const value = 1\n"
        )
        self.assertTrue(any("missing critical network-response/request wait" in finding for finding in findings))
        self.assertFalse(any("fixed sleep" in finding for finding in findings))
        self.assertFalse(any("direct page.goto" in finding for finding in findings))


if __name__ == "__main__":
    unittest.main()
