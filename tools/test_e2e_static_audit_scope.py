from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

from tools.e2e_static_audit import audit_text


def normalized_browser_url(url: str) -> tuple[str, str]:
    script = (
        "const url = new URL(process.argv[1], 'http://127.0.0.1:31873');"
        "process.stdout.write(JSON.stringify([url.origin, url.pathname]));"
    )
    result = subprocess.run(
        ["node", "-e", script, url],
        check=True,
        capture_output=True,
        text=True,
    )
    origin, pathname = json.loads(result.stdout)
    return origin, pathname


def normalized_browser_concatenation(left: str, right: str) -> tuple[str, str]:
    script = (
        "const destination = process.argv[1] + process.argv[2];"
        "const url = new URL(destination, 'http://127.0.0.1:31873');"
        "process.stdout.write(JSON.stringify([url.origin, url.pathname]));"
    )
    result = subprocess.run(
        ["node", "-e", script, left, right],
        check=True,
        capture_output=True,
        text=True,
    )
    origin, pathname = json.loads(result.stdout)
    return origin, pathname


class E2EStaticAuditMarkerScopeTests(unittest.TestCase):
    def audit_email_reset_entry(self, argument: str) -> list[str]:
        source = (
            "const response = page.waitForResponse(() => true)\n"
            "// E2E_GUARDIAN_EMAIL_RESET_ENTRY_POINT: synthetic emailed reset entry\n"
            f"page.goto({argument})"
        )
        return audit_text(source, Path("email-reset.spec.ts"))

    def test_static_same_origin_invitation_token_is_allowed(self) -> None:
        argument = "'/invitations/synthetic-reset-proof'"
        self.assertEqual(
            normalized_browser_url("/invitations/synthetic-reset-proof"),
            ("http://127.0.0.1:31873", "/invitations/synthetic-reset-proof"),
        )
        self.assertFalse(
            any("direct page.goto" in item for item in self.audit_email_reset_entry(argument))
        )

    def test_browser_normalization_rejects_literal_and_encoded_traversal(self) -> None:
        cases = [
            ("'/invitations/../unexpected-terminal'", "/invitations/../unexpected-terminal"),
            (
                "'/invitations/%2e%2e/unexpected-terminal'",
                "/invitations/%2e%2e/unexpected-terminal",
            ),
        ]
        for argument, browser_url in cases:
            with self.subTest(argument=argument):
                _, normalized_path = normalized_browser_url(browser_url)
                self.assertEqual(normalized_path, "/unexpected-terminal")
                self.assertTrue(
                    any(
                        "direct page.goto" in item
                        for item in self.audit_email_reset_entry(argument)
                    )
                )

    def test_dynamic_concatenation_that_normalizes_outside_route_is_rejected(self) -> None:
        _, normalized_path = normalized_browser_concatenation(
            "/invitations/reset-token", "/../../unexpected-terminal"
        )
        self.assertEqual(normalized_path, "/unexpected-terminal")
        findings = self.audit_email_reset_entry(
            "'/invitations/reset-token' + '/../../unexpected-terminal'"
        )
        self.assertTrue(any("direct page.goto" in item for item in findings))

    def test_template_expression_is_rejected(self) -> None:
        self.assertTrue(
            any(
                "direct page.goto" in item
                for item in self.audit_email_reset_entry("`/invitations/${token}`")
            )
        )

    def test_external_origin_is_rejected_even_with_invitation_path(self) -> None:
        origin, pathname = normalized_browser_url("https://outside.invalid/invitations/token")
        self.assertEqual((origin, pathname), ("https://outside.invalid", "/invitations/token"))
        self.assertTrue(
            any(
                "direct page.goto" in item
                for item in self.audit_email_reset_entry(
                    "'https://outside.invalid/invitations/token'"
                )
            )
        )

    def test_additional_path_query_fragment_and_encoded_path_are_rejected(self) -> None:
        arguments = [
            "'/admin/secret'",
            "'/invitations/token/extra'",
            "'/invitations/token?next=/home'",
            "'/invitations/token#fragment'",
            "'/invitations/%74oken'",
            "'/invitations\\\\token'",
        ]
        for argument in arguments:
            with self.subTest(argument=argument):
                self.assertTrue(
                    any(
                        "direct page.goto" in item
                        for item in self.audit_email_reset_entry(argument)
                    )
                )

    def test_marker_does_not_allow_unrelated_guardian_text(self) -> None:
        source = (
            "const response = page.waitForResponse(() => true)\n"
            "// GUARDIAN email reset entry point\n"
            "page.goto('/admin/secret')"
        )
        self.assertTrue(
            any("direct page.goto" in item for item in audit_text(source, Path("scope.spec.ts")))
        )

    def test_plain_application_root_entry_remains_allowed(self) -> None:
        source = "const response = page.waitForResponse(() => true)\npage.goto('/')"
        self.assertFalse(
            any("direct page.goto" in finding for finding in audit_text(source, Path("root.spec.ts")))
        )

    def test_explicit_root_marker_remains_scoped_to_static_root(self) -> None:
        source = (
            "const response = page.waitForResponse(() => true)\n"
            "// E2E_GUARDIAN_ENTRY_POINT\n"
            "page.goto('/')"
        )
        self.assertFalse(
            any("direct page.goto" in item for item in audit_text(source, Path("root.spec.ts")))
        )

    def test_explicit_negative_route_guard_remains_allowed(self) -> None:
        source = (
            "const response = page.waitForResponse(() => true)\n"
            "// Negative route-guard: verifies authorization rejection.\n"
            "page.goto('/admin/secret')"
        )
        self.assertFalse(
            any(
                "direct page.goto" in item
                for item in audit_text(source, Path("negative.spec.ts"))
            )
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

    def test_one_marker_does_not_allow_two_calls_on_the_same_line(self) -> None:
        source = (
            "const response = page.waitForResponse(() => true)\n"
            "// E2E_GUARDIAN_EMAIL_RESET_ENTRY_POINT\n"
            "page.goto('/invitations/reset-token'); page.goto('/admin/secret')"
        )
        navigation_findings = [
            item for item in audit_text(source, Path("scope.spec.ts")) if "direct page.goto" in item
        ]
        self.assertEqual(len(navigation_findings), 2)

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
