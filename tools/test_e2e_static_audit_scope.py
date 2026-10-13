from __future__ import annotations

import unittest
from pathlib import Path

from tools.e2e_static_audit import audit_text


class E2EStaticAuditMarkerScopeTests(unittest.TestCase):
    def test_plain_application_root_entry_remains_allowed(self) -> None:
        source = "const response = page.waitForResponse(() => true)\npage.goto('/')"
        self.assertFalse(
            any("direct page.goto" in finding for finding in audit_text(source, Path("root.spec.ts")))
        )

    def test_marker_must_be_adjacent_to_its_navigation(self) -> None:
        source = "// E2E_GUARDIAN_EMAIL_RESET_ENTRY_POINT\n\npage.goto('/invitations/reset-token')"
        self.assertTrue(
            any("direct page.goto" in finding for finding in audit_text(source, Path("scope.spec.ts")))
        )

    def test_one_marker_does_not_allow_a_second_navigation(self) -> None:
        source = (
            "// E2E_GUARDIAN_EMAIL_RESET_ENTRY_POINT\n"
            "page.goto('/invitations/reset-token')\n"
            "page.goto('/admin/secret')"
        )
        findings = audit_text(source, Path("scope.spec.ts"))
        navigation_findings = [finding for finding in findings if "direct page.goto" in finding]
        self.assertEqual(len(navigation_findings), 1)
        self.assertTrue(navigation_findings[0].endswith(":3: direct page.goto outside an explicit negative guard"))

    def test_removing_the_real_spec_marker_is_detected(self) -> None:
        spec = Path(
            "tests/e2e/playwright/profile-ui-recovery/reset-session-hydration.spec.ts"
        ).read_text(encoding="utf-8")
        without_marker = spec.replace(
            "// E2E_GUARDIAN_EMAIL_RESET_ENTRY_POINT: the emailed password-reset URL.\n", ""
        )
        self.assertTrue(
            any(
                "direct page.goto" in finding
                for finding in audit_text(without_marker, Path("recovery.spec.ts"))
            )
        )


if __name__ == "__main__":
    unittest.main()
