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
    r"(negative-route-guard|root-entry|email-reset-entry)\s+—\s+(\S.*)"
)
STATIC_GOTO_ARGUMENT = re.compile(r"\s*(['\"])([^'\"\\\r\n]*)\1\s*(?=[,)])")


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
    for label, pattern in RULES:
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
