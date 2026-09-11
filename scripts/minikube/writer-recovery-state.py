#!/usr/bin/env python3
"""Private, atomic, identity-bound state for partial writer recovery.

The state contains only recovery phase and replica counts. It is deliberately
not shell-sourced: an interrupted local run must not turn an untrusted file
into executable shell input.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path


VERSION = 2
PHASES = {
    "planned",
    "hcc-fencing",
    "hcc-fenced",
    "workflow-fencing",
    "workflow-fenced",
    "trace-fencing",
    "trace-fenced",
    "api-fencing",
    "api-fenced",
    "policy-ready",
    "roles-ready",
    "api-restoring",
    "api-restored",
    "overlay-applying",
    "overlay-applied",
}


def fail(message: str, status: int = 2) -> None:
    raise SystemExit(f"WRITER_RECOVERY_STATE_ERROR: {message}")


def validate_identity(args: argparse.Namespace) -> dict[str, str]:
    values = {
        "profile": args.profile,
        "context": args.context,
        "worktree": args.worktree,
        "branch": args.branch,
        "head": args.head,
    }
    if any(not value or any(char in value for char in "\r\n\t") for value in values.values()):
        fail("identity fields must be non-empty and control-character free")
    return values


def validate_replica(value: str, name: str, *, allow_zero: bool = False) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        fail(f"{name} replica count is not an integer")
    if number < 0 or (number == 0 and not allow_zero):
        fail(f"{name} replica count is outside the supported recovery range")
    return number


def state_path(args: argparse.Namespace) -> Path:
    path = Path(args.path)
    if not path.is_absolute() or path.name != path.name.replace("/", ""):
        fail("state path must be an absolute file path")
    if path.is_symlink():
        fail(f"refusing a symlinked state path: {path}")
    return path


def write_state(args: argparse.Namespace) -> None:
    identity = validate_identity(args)
    if args.phase not in PHASES:
        fail(f"unsupported recovery phase: {args.phase}")
    payload = {
        "version": VERSION,
        **identity,
        "phase": args.phase,
        "hccReplicas": validate_replica(args.hcc, "hcc", allow_zero=True),
        "workflowReplicas": validate_replica(args.workflow, "workflow", allow_zero=True),
        "traceReplicas": validate_replica(args.trace, "trace-maintenance-worker", allow_zero=True),
        "controlApiReplicas": validate_replica(args.control_api, "control-api"),
    }
    path = state_path(args)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists() and path.is_symlink():
        fail(f"refusing a symlinked state path: {path}")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def read_state(args: argparse.Namespace) -> None:
    identity = validate_identity(args)
    path = state_path(args)
    if not path.exists():
        print("NONE")
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read state: {error}")
    if not isinstance(data, dict) or data.get("version") != VERSION:
        fail("state version is unsupported")
    # The recorded head is historical evidence of the interrupted run. The
    # durable lane identity is profile/context/worktree/branch; a new commit
    # on the same owned lane must be able to resume and revalidate freshness
    # through the exact-head pre-gate marker instead of losing state solely
    # because HEAD advanced.
    for key, expected in identity.items():
        if key == "head":
            continue
        if data.get(key) != expected:
            fail(f"state identity mismatch for {key}; refusing to touch another lane")
    stored_head = data.get("head")
    if not isinstance(stored_head, str) or not stored_head or any(
        char in stored_head for char in "\r\n\t"
    ):
        fail("state historical HEAD is invalid")
    phase = data.get("phase")
    if phase not in PHASES:
        fail("state phase is invalid")
    hcc = validate_replica(str(data.get("hccReplicas")), "hcc", allow_zero=True)
    workflow = validate_replica(str(data.get("workflowReplicas")), "workflow", allow_zero=True)
    trace = validate_replica(
        str(data.get("traceReplicas")), "trace-maintenance-worker", allow_zero=True
    )
    control_api = validate_replica(str(data.get("controlApiReplicas")), "control-api")
    output = f"{phase}|{hcc}|{workflow}|{trace}|{control_api}"
    if args.include_head:
        output += f"|{stored_head}"
    print(output)


def clear_state(args: argparse.Namespace) -> None:
    path = state_path(args)
    if path.exists() or path.is_symlink():
        if path.is_symlink():
            fail(f"refusing to unlink a symlinked state path: {path}")
        path.unlink()


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    subparsers = result.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--path", required=True)
    common.add_argument("--profile", required=True)
    common.add_argument("--context", required=True)
    common.add_argument("--worktree", required=True)
    common.add_argument("--branch", required=True)
    common.add_argument("--head", required=True)
    write = subparsers.add_parser("write", parents=[common])
    write.add_argument("--phase", required=True)
    write.add_argument("--hcc", required=True)
    write.add_argument("--workflow", required=True)
    write.add_argument("--trace", required=True)
    write.add_argument("--control-api", required=True)
    read = subparsers.add_parser("read", parents=[common])
    read.add_argument("--include-head", action="store_true")
    subparsers.add_parser("clear", parents=[common])
    return result


def main() -> None:
    args = parser().parse_args()
    if args.command == "write":
        write_state(args)
    elif args.command == "read":
        read_state(args)
    else:
        clear_state(args)


if __name__ == "__main__":
    main()
