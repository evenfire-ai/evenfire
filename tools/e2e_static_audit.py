#!/usr/bin/env python3
"""Small, dependency-free E2E Guardian gate for changed E2E files.

This is intentionally a conservative source audit. It does not replace a real
journey; browser-only requirements are applied only to browser spec files.
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

BROWSER_SPEC_SUFFIXES = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"}


def audit_file(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    findings: list[str] = []
    is_browser_spec = path.suffix.lower() in BROWSER_SPEC_SUFFIXES
    for label, pattern in RULES:
        for match in pattern.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            findings.append(f"{path}:{line}: {label}")

    # Electron GFS browser discovery is brokered through the main process IPC
    # bridge, so there is no renderer HTTP request to await. Such specs must
    # opt in with an explicit, explanatory marker rather than adding a fake
    # network wait that can hide a broken user transition.
    if (
        is_browser_spec
        and "waitForResponse" not in text
        and "waitForRequest" not in text
        and "E2E_GUARDIAN_IPC_FLOW" not in text
    ):
        findings.append(f"{path}: missing critical network-response/request wait")

    # Direct navigation is allowed only in an explicitly negative terminal
    # guard, or as the first application-root entry when the spec opts into
    # E2E_GUARDIAN_ENTRY_POINT. Deep links stay forbidden on that path.
    for match in re.finditer(r"\bpage\.goto\s*\(", text if is_browser_spec else ""):
        before = text[max(0, match.start() - 240) : match.start()]
        after = text[match.end() : match.end() + 80]
        if re.search(r"terminal|deep.?link|foreign|missing|guard", before, re.IGNORECASE):
            continue
        if "E2E_GUARDIAN_ENTRY_POINT" in text and re.match(
            r"""\s*['\"]/?['\"]""", after
        ):
            continue
        line = text.count("\n", 0, match.start()) + 1
        findings.append(f"{path}:{line}: direct page.goto outside an explicit negative guard")
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
