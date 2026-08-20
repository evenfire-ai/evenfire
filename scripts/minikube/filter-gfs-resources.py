#!/usr/bin/env python3
"""Remove GFS-owned Kubernetes documents from an intentionally non-GFS apply.

This is used only by non-T2 pre-gate deployment syncs. The filter is explicit
about the small set of cluster-scoped and control-plane GFS boundary objects;
unknown documents are retained rather than guessed away.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


def field(document: str, expression: str) -> str:
    match = re.search(expression, document, flags=re.MULTILINE)
    return match.group(1) if match else ""


def is_gfs_owned(document: str) -> bool:
    kind = field(document, r"^kind:\s*([^\s#]+)\s*$")
    name = field(document, r"^  name:\s*([^\s#]+)\s*$")
    namespace = field(document, r"^  namespace:\s*([^\s#]+)\s*$")
    if kind == "Namespace" and name == "gfs":
        return True
    if namespace == "gfs" or kind == "GlobalFileSystem":
        return True
    if kind == "CustomResourceDefinition" and name == "globalfilesystems.clerum.io":
        return True
    if kind == "NetworkPolicy" and name in {
        "control-api-to-gfsc",
        "control-postgres-from-gfs-controller",
        "deny-all-gfs",
    }:
        return True
    return False


def read_documents(paths: list[str]) -> str:
    if not paths:
        return sys.stdin.read()
    return "\n---\n".join(Path(path).read_text() for path in paths)


def main() -> int:
    source = read_documents(sys.argv[1:])
    documents = re.split(r"(?m)^---\s*$", source)
    kept = [document.rstrip() for document in documents if document.strip() and not is_gfs_owned(document)]
    if kept:
        sys.stdout.write("\n---\n".join(kept) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
