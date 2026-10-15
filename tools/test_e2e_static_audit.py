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

    def test_adjacent_email_reset_annotation_allows_invitation_entry(self) -> None:
        source = "// E2E_GUARDIAN_NAVIGATION: email-reset-entry — emailed reset link\npage.goto('/invitations/reset-token')"
        self.assertEqual(self.findings(source), [])

    def test_email_reset_annotation_does_not_allow_non_invitation_path(self) -> None:
        source = "// E2E_GUARDIAN_NAVIGATION: email-reset-entry — emailed reset link\npage.goto('/admin/secret')"
        self.assertTrue(any("direct page.goto" in finding for finding in self.findings(source)))

    def test_negative_route_annotation_requires_a_static_local_route(self) -> None:
        source = "// E2E_GUARDIAN_NAVIGATION: negative-route-guard — verify rejection\npage.goto('/admin/secret')"
        self.assertEqual(self.findings(source), [])
        for destination in [
            "`/admin/${route}`",
            "'/admin/../secret'",
            "'/admin/%2e%2e/secret'",
            "'//outside.invalid/admin'",
            "'https://outside.invalid/admin'",
            "'/admin/secret?next=/'",
            "'/admin/secret#fragment'",
        ]:
            with self.subTest(destination=destination):
                dynamic = (
                    "// E2E_GUARDIAN_NAVIGATION: negative-route-guard — verify rejection\n"
                    f"page.goto({destination})"
                )
                self.assertTrue(
                    any("direct page.goto" in finding for finding in self.findings(dynamic))
                )

    def test_navigation_annotation_requires_a_known_kind_and_reason(self) -> None:
        for annotation in [
            "// E2E_GUARDIAN_NAVIGATION: arbitrary — anything",
            "// E2E_GUARDIAN_NAVIGATION: root-entry — ",
            "// E2E_GUARDIAN_EMAIL_RESET_ENTRY_POINT: old marker",
        ]:
            with self.subTest(annotation=annotation):
                self.assertTrue(
                    any(
                        "direct page.goto" in finding
                        for finding in self.findings(f"{annotation}\npage.goto('/admin/secret')")
                    )
                )

    def test_unrelated_guardian_text_does_not_allow_navigation(self) -> None:
        source = "// GUARDIAN documentation describes reset links\npage.goto('/admin/secret')"
        self.assertTrue(any("direct page.goto" in finding for finding in self.findings(source)))


if __name__ == "__main__":
    unittest.main()
