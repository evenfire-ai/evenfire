from __future__ import annotations

import unittest
from pathlib import Path

from tools.e2e_static_audit import audit_text


class E2EStaticAuditNavigationTests(unittest.TestCase):
    def findings(self, source: str) -> list[str]:
        return audit_text(
            "const response = page.waitForResponse(() => true)\n" + source,
            Path("recovery.spec.ts"),
        )

    def test_adjacent_email_marker_allows_invitation_reset_entry(self) -> None:
        source = "// E2E_GUARDIAN_EMAIL_RESET_ENTRY_POINT: emailed reset link\npage.goto('/invitations/reset-token')"
        self.assertEqual(self.findings(source), [])

    def test_email_marker_does_not_allow_non_invitation_path(self) -> None:
        source = "// E2E_GUARDIAN_EMAIL_RESET_ENTRY_POINT: emailed reset link\npage.goto('/admin/secret')"
        self.assertTrue(any("direct page.goto" in finding for finding in self.findings(source)))

    def test_unrelated_guardian_text_does_not_allow_navigation(self) -> None:
        source = "// GUARDIAN documentation describes reset links\npage.goto('/admin/secret')"
        self.assertTrue(any("direct page.goto" in finding for finding in self.findings(source)))


if __name__ == "__main__":
    unittest.main()
