#!/usr/bin/env python3
"""Write the durable T1 evidence projection of one Vitest JSON reporter.

The projection keeps the structure and the results of the run: every reported
file with its status and duration, every test with its titles, status and
duration, and the reporter counters. It drops every free-text field the
reporter carries (file-level `message`, assertion `failureMessages`), keeping
only how many there were, because those texts can contain values from the
system under test. Test and suite titles are authored in the repository and
are kept.

Usage: t1-reporter-projection.py <reporter.json> <package-root> <package> <lane> <output.json>

Exits non-zero, without writing a partial file, when the reporter cannot be
read or the projection cannot be written: T1 must fail rather than lose the
evidence.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

COUNTERS = (
    "success",
    "numTotalTestSuites",
    "numPassedTestSuites",
    "numFailedTestSuites",
    "numPendingTestSuites",
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
)


def duration_ms(item):
    start, end = item.get("startTime"), item.get("endTime")
    if isinstance(start, (int, float)) and isinstance(end, (int, float)):
        return int(end - start)
    value = item.get("duration")
    return int(value) if isinstance(value, (int, float)) else None


def relative_name(name, package_root):
    path = Path(name)
    if not path.is_absolute():
        return path.as_posix()
    try:
        return path.resolve().relative_to(package_root).as_posix()
    except ValueError:
        return path.name


def project(result, package_root, package, lane):
    files = []
    for item in result.get("testResults") or []:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ValueError("reporter contains a test result without a file name")
        tests = []
        for assertion in item.get("assertionResults") or []:
            tests.append(
                {
                    "ancestorTitles": [str(t) for t in assertion.get("ancestorTitles") or []],
                    "title": str(assertion.get("title") or ""),
                    "status": assertion.get("status"),
                    "durationMs": assertion.get("duration")
                    if isinstance(assertion.get("duration"), (int, float))
                    else None,
                    "failureMessageCount": len(assertion.get("failureMessages") or []),
                }
            )
        files.append(
            {
                "file": relative_name(item["name"], package_root),
                "status": item.get("status"),
                "durationMs": duration_ms(item),
                "fileMessageOmitted": bool(item.get("message")),
                "tests": tests,
            }
        )
    if not files:
        raise ValueError("reporter testResults is missing or empty")
    return {
        "schema": "t1-reporter-projection/v1",
        "package": package,
        "lane": lane,
        "counters": {key: result.get(key) for key in COUNTERS},
        "omitted": "file messages and failure messages (counts kept)",
        "files": files,
    }


def main(argv):
    if len(argv) != 6:
        print(
            "usage: t1-reporter-projection.py <reporter.json> <package-root> <package> <lane> <output.json>",
            file=sys.stderr,
        )
        return 2
    reporter, package_root, package, lane, output = argv[1:]
    try:
        result = json.loads(Path(reporter).read_text())
        projection = project(result, Path(package_root).resolve(), package, lane)
    except (OSError, ValueError) as error:
        print(f"T1 reporter projection failed: {error}", file=sys.stderr)
        return 1
    out = Path(output)
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=out.parent, prefix=".t1-projection-")
        with os.fdopen(fd, "w") as handle:
            json.dump(projection, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, out)
    except OSError as error:
        print(f"T1 reporter projection could not be written: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
