#!/usr/bin/env python3
"""Remove GFS-owned Kubernetes documents from an intentionally non-GFS apply.

This is used only by non-T2 pre-gate deployment syncs. The filter is explicit
about the small set of cluster-scoped and control-plane GFS boundary objects;
unknown documents are retained rather than guessed away.

The input is preserved byte-for-byte apart from removed documents. A small
structural scanner is used instead of a regular expression so document
separators inside block scalars and nested name fields cannot change which
Kubernetes object is filtered. PyYAML is not a repository-wide Python
dependency, while Python itself is already a hard dependency of this path.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Iterator, NamedTuple


class MappingLine(NamedTuple):
    indent: int
    key: str
    value: str


MAPPING_LINE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<key>[A-Za-z_][A-Za-z0-9_.-]*|\"[^\"\r\n]+\"|'[^'\r\n]+'):"
    r"(?:[ \t]*(?P<value>.*?))?[ \t]*$"
)
DOCUMENT_START = re.compile(r"^---[ \t]*(?:#.*)?(?:\r?\n)?$")
BLOCK_SCALAR = re.compile(r"^[|>](?:[+-]?[1-9]?|[1-9]?[+-]?)$")


def indentation(line: str) -> int:
    prefix = line[: len(line) - len(line.lstrip(" \t"))]
    return len(prefix.expandtabs(8))


def strip_inline_comment(value: str) -> str:
    comment = re.search(r"[ \t]+#", value)
    return value[: comment.start()] if comment else value


def scalar_value(value: str) -> str:
    value = strip_inline_comment(value).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def mapping_line(line: str) -> MappingLine | None:
    match = MAPPING_LINE.match(line.rstrip("\r\n"))
    if not match:
        return None
    return MappingLine(
        indentation(line),
        scalar_value(match.group("key")),
        match.group("value") or "",
    )


def starts_block_scalar(line: str) -> bool:
    parsed = mapping_line(line)
    if parsed and BLOCK_SCALAR.fullmatch(strip_inline_comment(parsed.value).strip()):
        return True

    sequence_value = re.match(
        r"^[ \t]*-[ \t]+(?P<value>[|>](?:[+-]?[1-9]?|[1-9]?[+-]?))[ \t]*(?:#.*)?$",
        line.rstrip("\r\n"),
    )
    return bool(sequence_value)


def split_documents(source: str) -> list[str]:
    documents: list[str] = []
    current: list[str] = []
    block_parent_indent: int | None = None

    for line in source.splitlines(keepends=True):
        if DOCUMENT_START.fullmatch(line):
            if current:
                documents.append("".join(current))
            current = []
            block_parent_indent = None
            continue

        if block_parent_indent is not None and line.strip():
            if indentation(line) <= block_parent_indent:
                block_parent_indent = None

        current.append(line)
        if block_parent_indent is None and starts_block_scalar(line):
            block_parent_indent = indentation(line)

    if current:
        documents.append("".join(current))
    return documents


def structural_mappings(document: str) -> Iterator[MappingLine]:
    block_parent_indent: int | None = None
    for line in document.splitlines(keepends=True):
        if block_parent_indent is not None and line.strip():
            if indentation(line) <= block_parent_indent:
                block_parent_indent = None
            else:
                continue
        if block_parent_indent is not None:
            continue

        parsed = mapping_line(line)
        if parsed is not None:
            yield parsed
            if starts_block_scalar(line):
                block_parent_indent = parsed.indent


def inline_metadata(value: str) -> dict[str, str]:
    if not (value.strip().startswith("{") and value.strip().endswith("}")):
        return {}
    fields: dict[str, str] = {}
    for match in re.finditer(
        r"(?:^|,)\s*(name|namespace)\s*:\s*([^,}]+)", value.strip()[1:-1]
    ):
        fields[match.group(1)] = scalar_value(match.group(2))
    return fields


def is_gfs_owned(document: str) -> bool:
    kind = ""
    metadata: dict[str, str] = {}
    metadata_indent: int | None = None
    metadata_child_indent: int | None = None

    for parsed in structural_mappings(document):
        if parsed.indent == 0 and parsed.key == "kind":
            kind = scalar_value(parsed.value)
            continue

        if parsed.indent == 0 and parsed.key == "metadata":
            metadata_indent = parsed.indent
            metadata_child_indent = None
            metadata = inline_metadata(parsed.value)
            continue

        if metadata_indent is None:
            continue
        if parsed.indent <= metadata_indent:
            metadata_indent = None
            metadata_child_indent = None
            continue
        if metadata_child_indent is None:
            metadata_child_indent = parsed.indent
        if parsed.indent == metadata_child_indent and parsed.key in {"name", "namespace"}:
            metadata[parsed.key] = scalar_value(parsed.value)

    name = metadata.get("name", "")
    namespace = metadata.get("namespace", "")
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
    documents = split_documents(source)
    kept = [
        document.rstrip()
        for document in documents
        if document.strip() and not is_gfs_owned(document)
    ]
    if kept:
        sys.stdout.write("\n---\n".join(kept) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
