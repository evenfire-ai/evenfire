from __future__ import annotations

import json
import subprocess
import sys
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
            "// E2E_GUARDIAN_NAVIGATION: email-reset-entry — synthetic emailed reset entry\n"
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
            "// E2E_GUARDIAN_NAVIGATION: root-entry — public application root\n"
            "page.goto('/')"
        )
        self.assertFalse(
            any("direct page.goto" in item for item in audit_text(source, Path("root.spec.ts")))
        )

    def test_explicit_negative_route_guard_remains_allowed(self) -> None:
        source = (
            "const response = page.waitForResponse(() => true)\n"
            "// E2E_GUARDIAN_NAVIGATION: negative-route-guard — verifies authorization rejection\n"
            "page.goto('/admin/secret')"
        )
        self.assertFalse(
            any(
                "direct page.goto" in item
                for item in audit_text(source, Path("negative.spec.ts"))
            )
        )

    def test_marker_must_be_adjacent_to_its_navigation(self) -> None:
        source = "// E2E_GUARDIAN_NAVIGATION: email-reset-entry — emailed entry\n\npage.goto('/invitations/reset-token')"
        self.assertTrue(
            any("direct page.goto" in finding for finding in audit_text(source, Path("scope.spec.ts")))
        )

    def test_one_marker_does_not_allow_a_second_navigation(self) -> None:
        source = (
            "// E2E_GUARDIAN_NAVIGATION: email-reset-entry — emailed entry\n"
            "page.goto('/invitations/reset-token')\n"
            "page.goto('/admin/secret')"
        )
        findings = audit_text(source, Path("scope.spec.ts"))
        navigation_findings = [finding for finding in findings if "direct page.goto" in finding]
        self.assertEqual(len(navigation_findings), 1)
        self.assertTrue(navigation_findings[0].endswith(":3: direct page.goto outside an explicit navigation annotation"))

    def test_one_marker_does_not_allow_two_calls_on_the_same_line(self) -> None:
        source = (
            "const response = page.waitForResponse(() => true)\n"
            "// E2E_GUARDIAN_NAVIGATION: email-reset-entry — emailed entry\n"
            "page.goto('/invitations/reset-token'); page.goto('/admin/secret')"
        )
        navigation_findings = [
            item for item in audit_text(source, Path("scope.spec.ts")) if "navigation annotation" in item
        ]
        self.assertEqual(len(navigation_findings), 2)

    def test_removing_the_real_spec_marker_is_detected(self) -> None:
        spec = Path(
            "tests/e2e/playwright/profile-ui-recovery/reset-session-hydration.spec.ts"
        ).read_text(encoding="utf-8")
        without_marker = spec.replace(
            "// E2E_GUARDIAN_NAVIGATION: email-reset-entry — the synthetic emailed reset URL\n", ""
        )
        self.assertTrue(
            any(
                "direct page.goto" in finding
                for finding in audit_text(without_marker, Path("recovery.spec.ts"))
            )
        )

    def test_negative_route_annotation_rejects_dynamic_or_unsafe_destinations(self) -> None:
        prefix = "// E2E_GUARDIAN_NAVIGATION: negative-route-guard — verify auth rejection\n"
        for destination in [
            "`/admin/${resource}`",
            "'/admin/../secret'",
            "'/admin/%2e%2e/secret'",
            "'//outside.invalid/admin'",
            "'https://outside.invalid/admin'",
            "'/admin/secret?next=/'",
            "'/admin/secret#fragment'",
            "'/admin\\\\secret'",
        ]:
            with self.subTest(destination=destination):
                findings = audit_text(prefix + f"page.goto({destination})", Path("guard.spec.ts"))
                self.assertTrue(any("direct page.goto" in finding for finding in findings))

    def test_root_annotation_cannot_authorize_another_destination(self) -> None:
        source = (
            "// E2E_GUARDIAN_NAVIGATION: root-entry — public application root\n"
            "page.goto('/admin/secret')"
        )
        findings = audit_text(source, Path("root.spec.ts"))
        self.assertTrue(any("does not match" in finding for finding in findings))

    def fixture_agent_guard(self, route: str, *, path: Path | None = None) -> list[str]:
        source = (
            "// E2E_GUARDIAN_IPC_FLOW: Desktop uses real main-process IPC.\n"
            "import { readEvidence, scenarios } from '../helpers/approved-tools-scenarios'\n"
            "const cases = scenarios()\n"
            "test('unauthenticated agent route guard prevents connector use', async ({ page }) => {\n"
            "  const scenario = cases[0]!\n"
            "  const before = await readEvidence(scenario)\n"
            "  // E2E_GUARDIAN_NAVIGATION: fixture-agent-route-guard — prepared agent route stays protected\n"
            f"  await page.goto({route})\n"
            "  await expect(page.getByLabel('Username or email')).toBeVisible()\n"
            "  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()\n"
            "  await expect(page.getByRole('button', { name: 'Add connector', exact: true })).toHaveCount(0)\n"
            "  await expect(page.getByLabel('Main navigation')).toHaveCount(0)\n"
            "  expect((await readEvidence(scenario)).calls).toEqual(before.calls)\n"
            "})\n"
        )
        return audit_text(
            source,
            path
            or Path("tests/e2e/playwright/desktop/codex-subscription-approved-tools.spec.ts"),
        )

    def test_fixture_created_agent_route_is_allowed_only_for_its_evidence_scenario(self) -> None:
        self.assertFalse(
            any(
                "direct page.goto" in item
                for item in self.fixture_agent_guard("`/agents/${scenario.agentName}/connectors`")
            )
        )

    def test_fixture_agent_route_exception_rejects_other_files_and_destinations(self) -> None:
        cases = [
            (
                "`/agents/${scenario.agentName}/connectors`",
                Path("tests/e2e/playwright/other.spec.ts"),
            ),
            ("destination", None),
            ("`/agents/${scenario.otherName}/connectors`", None),
            ("`/agents/${scenario.agentName}/connectors/extra`", None),
            ("`https://outside.invalid/agents/${scenario.agentName}/connectors`", None),
            ("`/agents/${scenario.agentName}/connectors?next=/`", None),
            ("`/agents/${scenario.agentName}/connectors#fragment`", None),
            ("`/agents/${scenario.agentName.replace('/', '')}/connectors`", None),
            ("`/agents/${scenario.agentName}/../connectors`", None),
            ("`/agents/${scenario.agentName}/%2e%2e/connectors`", None),
            ("`/agents/${scenario.agentName}/connectors` + '/extra'", None),
            ("`/agents/${scenario.agentName}/connectors` + '?next=/'", None),
        ]
        for route, path in cases:
            with self.subTest(route=route, path=path):
                self.assertTrue(
                    any("direct page.goto" in item for item in self.fixture_agent_guard(route, path=path))
                )

    def test_fixture_agent_exception_requires_same_scenario_evidence_before_and_after(self) -> None:
        source = (
            "// E2E_GUARDIAN_IPC_FLOW: Desktop uses real main-process IPC.\n"
            "import { readEvidence, scenarios } from '../helpers/approved-tools-scenarios'\n"
            "const cases = scenarios()\n"
            "test('unauthenticated agent route guard prevents connector use', async ({ page }) => {\n"
            "  const scenario = cases[0]!\n"
            "  const before = await readEvidence(cases[1]!)\n"
            "  // E2E_GUARDIAN_NAVIGATION: fixture-agent-route-guard — prepared agent route stays protected\n"
            "  await page.goto(`/agents/${scenario.agentName}/connectors`)\n"
            "  await expect(page.getByLabel('Username or email')).toBeVisible()\n"
            "  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()\n"
            "  await expect(page.getByRole('button', { name: 'Add connector', exact: true })).toHaveCount(0)\n"
            "  await expect(page.getByLabel('Main navigation')).toHaveCount(0)\n"
            "  expect((await readEvidence(scenario)).calls).toEqual(before.calls)\n"
            "})\n"
        )
        self.assertTrue(
            any(
                "direct page.goto" in item
                for item in audit_text(
                    source,
                    Path("tests/e2e/playwright/desktop/codex-subscription-approved-tools.spec.ts"),
                )
            )
        )

    def test_fixture_agent_exception_requires_scenarios_fixture_provenance(self) -> None:
        source = (
            "// E2E_GUARDIAN_IPC_FLOW: Desktop uses real main-process IPC.\n"
            "import { readEvidence, scenarios } from '../helpers/approved-tools-scenarios'\n"
            "const cases = loadUntrustedCases()\n"
            "test('unauthenticated agent route guard prevents connector use', async ({ page }) => {\n"
            "  const scenario = cases[0]!\n"
            "  const before = await readEvidence(scenario)\n"
            "  // E2E_GUARDIAN_NAVIGATION: fixture-agent-route-guard — prepared agent route stays protected\n"
            "  await page.goto(`/agents/${scenario.agentName}/connectors`)\n"
            "  await expect(page.getByLabel('Username or email')).toBeVisible()\n"
            "  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()\n"
            "  await expect(page.getByRole('button', { name: 'Add connector', exact: true })).toHaveCount(0)\n"
            "  await expect(page.getByLabel('Main navigation')).toHaveCount(0)\n"
            "  expect((await readEvidence(scenario)).calls).toEqual(before.calls)\n"
            "})\n"
        )
        self.assertTrue(
            any(
                "direct page.goto" in item
                for item in audit_text(
                    source,
                    Path("tests/e2e/playwright/desktop/codex-subscription-approved-tools.spec.ts"),
                )
            )
        )


def run_tests() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    test_count = suite.countTestCases()
    if test_count == 0:
        print("E2E static-audit regression matrix collected zero tests", file=sys.stderr)
        return 2

    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(run_tests())
