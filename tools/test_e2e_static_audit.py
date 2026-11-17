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

    def test_storage_read_does_not_permit_session_mutations(self) -> None:
        self.assertEqual(self.findings("const value = localStorage.getItem('credential')"), [])
        for action in [
            "localStorage.setItem('credential', 'value')",
            "localStorage.removeItem('credential')",
            "localStorage.clear()",
            "localStorage.getItem = replacement",
            "localStorage[key] = 'value'",
            "sessionStorage.setItem('credential', 'value')",
            "storageState({ path: 'session.json' })",
        ]:
            with self.subTest(action=action):
                self.assertTrue(
                    any("browser storage/session mutation" in item for item in self.findings(action))
                )

    def test_runner_configuration_does_not_exempt_test_actions(self) -> None:
        config = "export default defineConfig({ retries: 0 })"
        self.assertEqual(audit_text(config, Path('playwright.config.ts')), [])
        for action in ["test('case', () => {})", "test.describe.serial('suite', () => {})", "page.goto('/admin/secret')"]:
            with self.subTest(action=action):
                findings = audit_text(f"{config}\n{action}", Path('playwright.config.ts'))
                self.assertTrue(any("missing critical" in finding for finding in findings))

    def test_user_detail_navigation_requires_a_validated_uuid(self) -> None:
        annotation = "// E2E_GUARDIAN_NAVIGATION: user-detail-entry — operator opens member"
        destination = (
            "page.goto(`/users-and-teams/users/${/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
            "[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(userId)?.[0] ?? "
            "(() => { throw new Error('Invalid user ID') })()}`)"
        )
        valid = f"{annotation}\n{destination}"
        self.assertEqual(self.findings(valid), [])
        formatted = destination.replace('${/', '${\n  /').replace('})()}`)', '})()\n}`)')
        self.assertEqual(self.findings(f"{annotation}\n{formatted}"), [])

        for altered in [
            f"{annotation}\npage.goto(`/users-and-teams/users/${{userId}}`)",
            valid.replace("{8}", "+", 1),
            valid.replace(".exec(userId)", ".exec(otherId)"),
            valid.replace("/users-and-teams/users/", "/users-and-teams/teams/"),
            valid.replace("user-detail-entry", "root-entry"),
            valid.replace("})()}", "})()}/access"),
            valid.replace("throw new Error('Invalid user ID')", "return userId"),
        ]:
            with self.subTest(source=altered):
                self.assertTrue(any("direct page.goto" in finding for finding in self.findings(altered)))

        guard_annotation = annotation.replace("user-detail-entry", "negative-route-guard")
        self.assertEqual(self.findings(f"{guard_annotation}\n{destination}"), [])


if __name__ == "__main__":
    unittest.main()
