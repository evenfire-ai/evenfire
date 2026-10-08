#!/usr/bin/env python3
"""Small, dependency-free E2E Guardian gate for changed Playwright specs.

This is intentionally a conservative source audit. It does not replace a real
browser run; it prevents common shortcuts from entering the large-upload
project where a green test must represent a user journey.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("fixed sleep", re.compile(r"\b(?:waitForTimeout|sleep\s*\()")),
    ("browser storage/session mutation", re.compile(r"\b(?:localStorage|sessionStorage|storageState)\b")),
    ("fragile positional selector", re.compile(r"\.(?:nth|first|last)\s*\(")),
    ("fragile text/class CSS selector", re.compile(r"locator\(\s*['\"](?:[^'\"]*has-text|[^'\"]*class=)")),
    ("core-route success mock", re.compile(r"(?:route|fulfill)\s*\([^\n]*(?:uploads|gfs|complete|parts)[^\n]*(?:status\s*:\s*2|status\s*:\s*20)")),
)

EMAIL_RESET_ENTRY_PATH = re.compile(r"/invitations/[A-Za-z0-9_-]+")
SAFE_STATIC_APP_PATH = re.compile(r"/(?:[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*)?")
NAVIGATION_ANNOTATION = re.compile(
    r"\s*//\s*E2E_GUARDIAN_NAVIGATION:\s*"
    r"(negative-route-guard|root-entry|email-reset-entry|fixture-agent-route-guard)\s+—\s+(\S.*)"
)
STATIC_GOTO_ARGUMENT = re.compile(r"\s*(['\"])([^'\"\\\r\n]*)\1\s*(?=[,)])")
FIXTURE_AGENT_GOTO_ARGUMENT = re.compile(
    r"\s*`/agents/\$\{scenario\.agentName\}/connectors`\s*(?=[,)])"
)
FIXTURE_AGENT_GUARD_SPEC = Path(
    "tests/e2e/playwright/desktop/codex-subscription-approved-tools.spec.ts"
)
FIXTURE_AGENT_GUARD_TITLE = "unauthenticated agent route guard prevents connector use"


def _fixture_agent_sources_are_safe() -> bool:
    repository_root = Path(__file__).resolve().parents[1]
    scenarios_path = repository_root / "tests/e2e/playwright/helpers/approved-tools-scenarios.ts"
    preparer_path = repository_root / "scripts/e2e/prepare-codex-approved-tools.mjs"
    if not scenarios_path.is_file() or not preparer_path.is_file():
        return False
    scenarios = scenarios_path.read_text(encoding="utf-8")
    preparer = preparer_path.read_text(encoding="utf-8")
    safe_name_validation = re.search(
        r"for \(const key of \['runId', 'agentName', 'connectorName', 'contextName'\] as const\)"
        r"\s*\{\s*if \(!/\^\[a-zA-Z0-9_-\]\{1,80\}\$/.test\(row\[key\]\)\)",
        scenarios,
    )
    unique_agent_names = re.search(
        r"for \(const key of \['runId', 'agentName', 'contextName', 'connectorName', 'fixtureUrl'\] as const\)"
        r"\s*\{\s*if \(new Set\(rows\.map\(row => row\[key\]\)\)\.size !== 3\)",
        scenarios,
    )
    return bool(
        safe_name_validation
        and unique_agent_names
        and "agentName: `${run}-agent-${label}`" in preparer
    )


def _is_fixture_agent_guard(text: str, path: Path, match: re.Match[str]) -> bool:
    repository_root = Path(__file__).resolve().parents[1]
    try:
        if path.resolve() != repository_root / FIXTURE_AGENT_GUARD_SPEC:
            return False
    except OSError:
        return False

    imports = re.search(
        r"import\s*\{(?P<bindings>[^}]+)\}\s*from\s*['\"]\.\./helpers/approved-tools-scenarios['\"]",
        text,
        re.DOTALL,
    )
    if (
        not imports
        or not re.search(r"\breadEvidence\b", imports.group("bindings"))
        or not re.search(r"\bscenarios\b", imports.group("bindings"))
        or text.count("const cases = scenarios()") != 1
        or not _fixture_agent_sources_are_safe()
    ):
        return False

    test_pattern = re.compile(
        r"test\(\s*(['\"])" + re.escape(FIXTURE_AGENT_GUARD_TITLE) + r"\1\s*,"
        r"\s*async\s*\(\s*\{\s*page\s*\}\s*\)\s*=>\s*\{"
        r"(?P<body>[\s\S]*?)\n\}\s*\)",
    )
    test_match = test_pattern.search(text)
    if not test_match:
        return False
    body = test_match.group("body")
    body_navigation = list(re.finditer(r"\bpage\.goto\s*\(", body))
    if len(body_navigation) != 1:
        return False
    body_goto = body_navigation[0]
    if not FIXTURE_AGENT_GOTO_ARGUMENT.match(body[body_goto.end() :]):
        return False
    if not re.search(r"const scenario = cases\[0\]!", body):
        return False
    if not re.search(r"const before = await readEvidence\(scenario\)", body):
        return False
    if not re.search(
        r"expect\(\(await readEvidence\(scenario\)\)\.calls\)\.toEqual\(before\.calls\)",
        body,
    ):
        return False
    if not re.search(
        r"expect\(page\.getByLabel\(['\"]Username or email['\"]\)\)\.toBeVisible\(\)",
        body,
    ):
        return False
    if not re.search(
        r"expect\(page\.getByRole\(['\"]button['\"],\s*\{\s*name:\s*['\"]Sign in['\"],"
        r"\s*exact:\s*true\s*\}\)\)\.toBeVisible\(\)",
        body,
    ):
        return False
    if not re.search(
        r"expect\(page\.getByRole\(['\"]button['\"],\s*\{\s*name:\s*['\"]Add connector"
        r"[^}]*\}\)\)\.toHaveCount\(0\)",
        body,
    ):
        return False
    if not re.search(
        r"expect\(page\.getByLabel\(['\"]Main navigation['\"]\)\)\.toHaveCount\(0\)",
        body,
    ):
        return False

    absolute_goto_start = test_match.start("body") + body_goto.start()
    return match.start() == absolute_goto_start


# Opt-in rules for files that declare E2E_GUARDIAN_STRICT_NETWORK: the journey
# must reach the real services, so any request interception and any forced
# click (which skips Playwright's actionability checks) fails the audit. Files
# without the marker keep the rules above unchanged.
STRICT_NETWORK_MARKER = "E2E_GUARDIAN_STRICT_NETWORK"
STRICT_NETWORK_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("network interception in a strict-network file", re.compile(r"\b(?:page|context)\.route\s*\(")),
    ("forced action in a strict-network file", re.compile(r"\bforce\s*:\s*true\b")),
)


def audit_file(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    return audit_text(text, path)


def _adjacent_line(text: str, position: int) -> str:
    line_start = text.rfind("\n", 0, position) + 1
    previous_line_end = line_start - 1
    previous_line_start = text.rfind("\n", 0, previous_line_end) + 1
    return text[previous_line_start:previous_line_end]


def audit_text(text: str, path: Path = Path("<source>")) -> list[str]:
    findings: list[str] = []
    rules = RULES + (STRICT_NETWORK_RULES if STRICT_NETWORK_MARKER in text else ())
    for label, pattern in rules:
        for match in pattern.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            findings.append(f"{path}:{line}: {label}")

    # Electron GFS browser discovery is brokered through the main process IPC
    # bridge, so there is no renderer HTTP request to await. Such specs must
    # opt in with an explicit, explanatory marker rather than adding a fake
    # network wait that can hide a broken user transition.
    if (
        "waitForResponse" not in text
        and "waitForRequest" not in text
        and "E2E_GUARDIAN_IPC_FLOW" not in text
    ):
        findings.append(f"{path}: missing critical network-response/request wait")

    # Navigation exceptions must be attached to the specific call. Searching a
    # broad look-behind for "guard" also matches "GUARDIAN" and lets one marker
    # bless later calls.
    navigation_matches = list(re.finditer(r"\bpage\.goto\s*\(", text))
    navigation_counts_by_line: dict[int, int] = {}
    for match in navigation_matches:
        line = text.count("\n", 0, match.start()) + 1
        navigation_counts_by_line[line] = navigation_counts_by_line.get(line, 0) + 1

    for match in navigation_matches:
        adjacent = _adjacent_line(text, match.start())
        after = text[match.end() : match.end() + 160]
        root_argument = STATIC_GOTO_ARGUMENT.match(after)
        line = text.count("\n", 0, match.start()) + 1
        if navigation_counts_by_line.get(line) != 1:
            findings.append(f"{path}:{line}: navigation annotation must authorize one page.goto")
            continue

        annotation = NAVIGATION_ANNOTATION.fullmatch(adjacent)
        destination = root_argument.group(2) if root_argument else None
        if (
            annotation
            and annotation.group(1) == "fixture-agent-route-guard"
            and FIXTURE_AGENT_GOTO_ARGUMENT.match(after)
            and _is_fixture_agent_guard(text, path, match)
        ):
            continue
        if destination in {"", "/"}:
            if annotation is None or annotation.group(1) == "root-entry":
                continue
            findings.append(f"{path}:{line}: direct page.goto does not match its navigation annotation")
            continue
        if not annotation or destination is None:
            findings.append(f"{path}:{line}: direct page.goto outside an explicit navigation annotation")
            continue

        kind = annotation.group(1)
        if kind == "root-entry" and destination in {"", "/"}:
            continue
        if kind == "email-reset-entry" and EMAIL_RESET_ENTRY_PATH.fullmatch(destination):
            continue
        if kind == "negative-route-guard" and SAFE_STATIC_APP_PATH.fullmatch(destination):
            continue
        findings.append(f"{path}:{line}: direct page.goto does not match its navigation annotation")
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()
    findings: list[str] = []
    for path in args.paths:
        if not path.is_file():
            findings.append(f"{path}: file does not exist")
            continue
        findings.extend(audit_file(path))
    if findings:
        print("E2E Guardian static audit: FAIL", file=sys.stderr)
        print("\n".join(findings), file=sys.stderr)
        return 1
    print(f"E2E Guardian static audit: PASS ({len(args.paths)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
