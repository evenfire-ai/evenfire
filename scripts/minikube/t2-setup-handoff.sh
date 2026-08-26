#!/usr/bin/env bash
# One-shot, local-only setup-complete handoff for the Minikube T2 harness.
# The raw inherited lease token is used only to derive an attestation hash; it
# is never written to disk or included in output.
# shellcheck disable=SC2034

t2_setup_handoff_apply_plan_result() {
  local result="${1:-}"
  case "$result" in
    consumed)
      INCREMENTAL_FULL_IMAGE_BUILD=false
      INCREMENTAL_FULL_DEPLOYMENT=false
      INCREMENTAL_TARGETS=()
      ;;
    rejected)
      # A requested handoff that cannot be consumed is never an optimization
      # hint. Restore the canonical safe reconcile regardless of what the
      # incremental classifier selected from local state.
      INCREMENTAL_FULL_IMAGE_BUILD=true
      INCREMENTAL_FULL_DEPLOYMENT=true
      INCREMENTAL_TARGETS=()
      ;;
    *)
      return 2
      ;;
  esac
}

t2_setup_handoff_cli() {
  local action="${1:-}"
  if [[ "$action" != create && "$action" != consume ]]; then
    printf 'usage: %s create | consume -- <image verification command...>\n' \
      "$(basename -- "${BASH_SOURCE[0]}")" >&2
    return 2
  fi
  shift
  if [[ "$action" == consume ]]; then
    if [[ "${1:-}" != -- ]]; then
      printf 'T2_SETUP_HANDOFF_REJECTED=VERIFY_COMMAND_REQUIRED\n' >&2
      return 1
    fi
    shift
    if [[ "$#" -eq 0 ]]; then
      printf 'T2_SETUP_HANDOFF_REJECTED=VERIFY_COMMAND_REQUIRED\n' >&2
      return 1
    fi
  elif [[ "$#" -ne 0 ]]; then
    printf 'T2_SETUP_HANDOFF_REJECTED=UNEXPECTED_ARGUMENT\n' >&2
    return 1
  fi

  python3 - "$action" "$@" <<'PY'
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

KIND = "evenfire.minikube-t2.setup-complete"
VERSION = 1
DEFAULT_TTL_SECONDS = 300
MAX_TTL_SECONDS = 600
MAX_HANDOFF_BYTES = 64 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
FULL_HEAD = re.compile(r"^[0-9a-f]{40,64}$")
SHA1 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class Rejected(Exception):
    def __init__(self, code):
        self.code = code


def reject(code):
    raise Rejected(code)


def required(name):
    value = os.environ.get(name, "")
    if not value:
        reject(f"{name}_REQUIRED")
    if any(character in value for character in ("\0", "\n", "\r")):
        reject(f"{name}_INVALID")
    return value


def git_value(project, *args):
    result = subprocess.run(
        ["git", "-C", str(project), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    if result.returncode != 0:
        reject("WORKTREE_GIT_METADATA_INVALID")
    value = result.stdout.strip()
    if not value:
        reject("WORKTREE_GIT_METADATA_INVALID")
    return value


def sha256_file(path):
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        reject("IMAGE_MANIFEST_UNREADABLE")
    return digest.hexdigest()


def iso8601(epoch):
    return (
        datetime.fromtimestamp(epoch, tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def parse_ttl():
    raw = os.environ.get("T2_SETUP_HANDOFF_TTL_SECONDS", str(DEFAULT_TTL_SECONDS))
    try:
        ttl = int(raw)
    except ValueError:
        reject("TTL_INVALID")
    if ttl < 1 or ttl > MAX_TTL_SECONDS:
        reject("TTL_INVALID")
    return ttl


def path_is_within(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def ensure_private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        metadata = path.lstat()
    except OSError:
        reject("STATE_ROOT_INVALID")
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        reject("STATE_ROOT_INVALID")
    if metadata.st_uid != os.getuid():
        reject("STATE_ROOT_INVALID")
    os.chmod(path, 0o700)


def context():
    project_input = Path(required("T2_PROJECT_DIR"))
    if not project_input.is_absolute():
        reject("WORKTREE_PATH_INVALID")
    try:
        project = project_input.resolve(strict=True)
    except OSError:
        reject("WORKTREE_PATH_INVALID")
    if not project.is_dir():
        reject("WORKTREE_PATH_INVALID")

    branch = required("T2_BRANCH")
    head = required("T2_HEAD")
    if not FULL_HEAD.fullmatch(head):
        reject("HEAD_INVALID")
    if git_value(project, "branch", "--show-current") != branch:
        reject("BRANCH_MISMATCH")
    if git_value(project, "rev-parse", "--verify", "HEAD") != head:
        reject("HEAD_MISMATCH")

    worktree_id = required("T2_WORKTREE_ID")
    canonical_worktree_id = hashlib.sha1(str(project).encode("utf-8")).hexdigest()
    if not SHA1.fullmatch(worktree_id) or worktree_id != canonical_worktree_id:
        reject("WORKTREE_ID_MISMATCH")

    run_id = required("T2_RUN_ID")
    profile = required("T2_PROFILE")
    kube_context = required("T2_CONTEXT")
    if not SAFE_ID.fullmatch(run_id):
        reject("RUN_ID_INVALID")
    if not SAFE_ID.fullmatch(profile) or not SAFE_ID.fullmatch(kube_context):
        reject("PROFILE_CONTEXT_INVALID")
    if profile != kube_context:
        reject("PROFILE_CONTEXT_MISMATCH")

    transition = required("T2_SETUP_HANDOFF_TRANSITION")
    if transition not in ("full-bootstrap", "full-reconcile"):
        reject("TRANSITION_INVALID")
    if os.environ.get("T2_SKIP_LOCK", "") != "true":
        reject("INHERITED_LOCK_REQUIRED")

    lock_identity = required("T2_LOCK_KEY")
    lock_token = required("T2_LOCK_TOKEN")
    expected_lock_identity = hashlib.sha1(
        b"\0".join(
            value.encode("utf-8")
            for value in (str(project), branch, head, profile, kube_context)
        )
    ).hexdigest()
    if not SHA1.fullmatch(lock_identity) or lock_identity != expected_lock_identity:
        reject("LOCK_IDENTITY_MISMATCH")
    lock_token_sha256 = hashlib.sha256(lock_token.encode("utf-8")).hexdigest()

    manifest_input = Path(required("T2_IMAGE_MANIFEST"))
    if not manifest_input.is_absolute() or manifest_input.is_symlink():
        reject("IMAGE_MANIFEST_PATH_INVALID")
    try:
        manifest = manifest_input.resolve(strict=True)
    except OSError:
        reject("IMAGE_MANIFEST_UNREADABLE")
    if not manifest.is_file() or not path_is_within(manifest, project):
        reject("IMAGE_MANIFEST_PATH_INVALID")

    local_state_input = project / ".local-notes"
    if local_state_input.is_symlink():
        reject("STATE_ROOT_INVALID")
    local_state_root = local_state_input.resolve(strict=False)
    if not path_is_within(local_state_root, project):
        reject("STATE_ROOT_INVALID")
    root_input = Path(
        os.environ.get(
            "T2_SETUP_HANDOFF_ROOT",
            str(local_state_root / "infra" / "t2-setup-handoffs"),
        )
    )
    if not root_input.is_absolute():
        reject("STATE_ROOT_INVALID")
    state_root = root_input.resolve(strict=False)
    if not path_is_within(state_root, local_state_root):
        reject("STATE_ROOT_INVALID")
    relative_root = os.path.relpath(state_root, project)
    ignored = subprocess.run(
        ["git", "-C", str(project), "check-ignore", "-q", "--", relative_root],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if ignored.returncode != 0:
        reject("STATE_ROOT_NOT_IGNORED")

    run_directory = state_root / worktree_id / run_id
    handoff = run_directory / "setup-complete.json"
    consumed = run_directory / "setup-complete.consumed.json"
    claim = run_directory / "setup-complete.consume.claim"

    return {
        "project": project,
        "branch": branch,
        "head": head,
        "worktree_id": worktree_id,
        "run_id": run_id,
        "profile": profile,
        "context": kube_context,
        "transition": transition,
        "lock_identity": lock_identity,
        "lock_token_sha256": lock_token_sha256,
        "manifest": manifest,
        "state_root": state_root,
        "run_directory": run_directory,
        "handoff": handoff,
        "consumed": consumed,
        "claim": claim,
        "ttl": parse_ttl(),
    }


def expected_document(values, issued_at):
    expires_at = issued_at + values["ttl"]
    return {
        "version": VERSION,
        "kind": KIND,
        "setupComplete": True,
        "transition": values["transition"],
        "runId": values["run_id"],
        "profile": values["profile"],
        "context": values["context"],
        "worktree": {
            "id": values["worktree_id"],
            "path": str(values["project"]),
        },
        "branch": values["branch"],
        "head": values["head"],
        "lock": {
            "identity": values["lock_identity"],
            "tokenSha256": values["lock_token_sha256"],
        },
        "imageManifest": {
            "path": str(values["manifest"]),
            "sha256": sha256_file(values["manifest"]),
        },
        "issuedAt": iso8601(issued_at),
        "expiresAt": iso8601(expires_at),
        "issuedAtEpoch": issued_at,
        "expiresAtEpoch": expires_at,
        "ttlSeconds": values["ttl"],
    }


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            reject("HANDOFF_MALFORMED")
        result[key] = value
    return result


def read_document(path):
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        reject("HANDOFF_MISSING")
    except OSError:
        reject("HANDOFF_UNREADABLE")
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        reject("HANDOFF_UNSAFE_FILE")
    if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
        reject("HANDOFF_UNSAFE_MODE")
    if metadata.st_size > MAX_HANDOFF_BYTES:
        reject("HANDOFF_MALFORMED")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
        opened_metadata = os.fstat(descriptor)
        if (
            opened_metadata.st_dev != metadata.st_dev
            or opened_metadata.st_ino != metadata.st_ino
            or not stat.S_ISREG(opened_metadata.st_mode)
            or opened_metadata.st_uid != os.getuid()
            or stat.S_IMODE(opened_metadata.st_mode) != 0o600
            or opened_metadata.st_size > MAX_HANDOFF_BYTES
        ):
            os.close(descriptor)
            reject("HANDOFF_CHANGED_DURING_READ")
        with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
            raw = handle.read(MAX_HANDOFF_BYTES + 1)
    except OSError:
        reject("HANDOFF_UNREADABLE")
    if len(raw.encode("utf-8")) > MAX_HANDOFF_BYTES:
        reject("HANDOFF_MALFORMED")
    try:
        return json.loads(raw, object_pairs_hook=reject_duplicate_keys)
    except (UnicodeError, json.JSONDecodeError, TypeError):
        reject("HANDOFF_MALFORMED")


def validate_document(values, path):
    document = read_document(path)
    expected_keys = {
        "version",
        "kind",
        "setupComplete",
        "transition",
        "runId",
        "profile",
        "context",
        "worktree",
        "branch",
        "head",
        "lock",
        "imageManifest",
        "issuedAt",
        "expiresAt",
        "issuedAtEpoch",
        "expiresAtEpoch",
        "ttlSeconds",
    }
    if not isinstance(document, dict) or set(document) != expected_keys:
        reject("HANDOFF_MALFORMED")
    if document.get("version") != VERSION or document.get("kind") != KIND:
        reject("HANDOFF_MALFORMED")
    if document.get("setupComplete") is not True:
        reject("SETUP_INCOMPLETE")

    scalar_expectations = {
        "transition": values["transition"],
        "runId": values["run_id"],
        "profile": values["profile"],
        "context": values["context"],
        "branch": values["branch"],
        "head": values["head"],
        "ttlSeconds": values["ttl"],
    }
    mismatch_codes = {
        "transition": "TRANSITION_MISMATCH",
        "runId": "RUN_ID_MISMATCH",
        "profile": "PROFILE_MISMATCH",
        "context": "CONTEXT_MISMATCH",
        "branch": "BRANCH_MISMATCH",
        "head": "HEAD_MISMATCH",
        "ttlSeconds": "TTL_MISMATCH",
    }
    for field, expected in scalar_expectations.items():
        if document.get(field) != expected:
            reject(mismatch_codes[field])

    worktree = document.get("worktree")
    if not isinstance(worktree, dict) or set(worktree) != {"id", "path"}:
        reject("HANDOFF_MALFORMED")
    if worktree.get("id") != values["worktree_id"]:
        reject("WORKTREE_ID_MISMATCH")
    if worktree.get("path") != str(values["project"]):
        reject("WORKTREE_PATH_MISMATCH")

    lock = document.get("lock")
    if not isinstance(lock, dict) or set(lock) != {"identity", "tokenSha256"}:
        reject("HANDOFF_MALFORMED")
    if lock.get("identity") != values["lock_identity"]:
        reject("LOCK_IDENTITY_MISMATCH")
    if lock.get("tokenSha256") != values["lock_token_sha256"]:
        reject("LOCK_TOKEN_MISMATCH")

    manifest = document.get("imageManifest")
    if not isinstance(manifest, dict) or set(manifest) != {"path", "sha256"}:
        reject("HANDOFF_MALFORMED")
    if manifest.get("path") != str(values["manifest"]):
        reject("IMAGE_MANIFEST_PATH_MISMATCH")
    recorded_digest = manifest.get("sha256")
    if not isinstance(recorded_digest, str) or not SHA256.fullmatch(recorded_digest):
        reject("HANDOFF_MALFORMED")
    if recorded_digest != sha256_file(values["manifest"]):
        reject("IMAGE_MANIFEST_DIGEST_MISMATCH")

    issued_at = document.get("issuedAtEpoch")
    expires_at = document.get("expiresAtEpoch")
    if type(issued_at) is not int or type(expires_at) is not int:
        reject("HANDOFF_MALFORMED")
    if expires_at - issued_at != values["ttl"]:
        reject("HANDOFF_MALFORMED")
    if document.get("issuedAt") != iso8601(issued_at):
        reject("HANDOFF_MALFORMED")
    if document.get("expiresAt") != iso8601(expires_at):
        reject("HANDOFF_MALFORMED")
    now = int(time.time())
    if issued_at > now + 30:
        reject("HANDOFF_FROM_FUTURE")
    if expires_at <= now:
        reject("HANDOFF_STALE")
    return document


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def create(values):
    if os.environ.get("T2_SETUP_HANDOFF_SETUP_COMPLETE", "") != "true":
        reject("SETUP_INCOMPLETE")
    ensure_private_directory(values["state_root"])
    ensure_private_directory(values["state_root"] / values["worktree_id"])
    ensure_private_directory(values["run_directory"])
    if values["handoff"].exists() or values["consumed"].exists() or values["claim"].exists():
        reject("HANDOFF_ALREADY_EXISTS")

    document = expected_document(values, int(time.time()))
    encoded = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".setup-complete.", dir=values["run_directory"]
    )
    temporary = Path(temporary_name)
    published = False
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        if values["handoff"].exists() or values["consumed"].exists() or values["claim"].exists():
            reject("HANDOFF_ALREADY_EXISTS")
        try:
            os.link(temporary, values["handoff"], follow_symlinks=False)
        except FileExistsError:
            reject("HANDOFF_ALREADY_EXISTS")
        published = True
        os.unlink(temporary)
        fsync_directory(values["run_directory"])
    finally:
        if not published and temporary.exists():
            temporary.unlink()
    print("T2_SETUP_HANDOFF_CREATED")


def consume(values, verification_command):
    if values["claim"].exists() or values["consumed"].exists():
        reject("HANDOFF_REPLAYED")
    validate_document(values, values["handoff"])

    verification_environment = os.environ.copy()
    verification_environment.pop("T2_LOCK_TOKEN", None)
    verified = subprocess.run(
        verification_command,
        cwd=values["project"],
        env=verification_environment,
        check=False,
        stdin=subprocess.DEVNULL,
    )
    if verified.returncode != 0:
        reject("IMAGE_VERIFICATION_FAILED")

    # Revalidate after the external verifier. Only then acquire the atomic
    # one-shot claim. A crash after this point leaves a replay marker and can
    # never authorize the optimization on a retry.
    validate_document(values, values["handoff"])
    try:
        os.mkdir(values["claim"], 0o700)
    except FileExistsError:
        reject("HANDOFF_REPLAYED")
    except OSError:
        reject("HANDOFF_CONSUME_FAILED")

    try:
        if values["consumed"].exists():
            reject("HANDOFF_REPLAYED")
        os.link(values["handoff"], values["consumed"], follow_symlinks=False)
        os.unlink(values["handoff"])
        fsync_directory(values["run_directory"])
        validate_document(values, values["consumed"])
    except FileNotFoundError:
        reject("HANDOFF_REPLAYED")
    except FileExistsError:
        reject("HANDOFF_REPLAYED")
    except OSError:
        reject("HANDOFF_CONSUME_FAILED")
    print("T2_SETUP_HANDOFF_CONSUMED")


def main():
    action = sys.argv[1]
    values = context()
    if action == "create":
        create(values)
        return
    verification_command = sys.argv[2:]
    if not verification_command:
        reject("VERIFY_COMMAND_REQUIRED")
    consume(values, verification_command)


try:
    main()
except Rejected as failure:
    print(f"T2_SETUP_HANDOFF_REJECTED={failure.code}", file=sys.stderr)
    sys.exit(1)
except Exception:
    # Do not echo exception values: environment or filesystem errors may carry
    # sensitive local material. The caller retains/forces the full reconcile.
    print("T2_SETUP_HANDOFF_REJECTED=INTERNAL_ERROR", file=sys.stderr)
    sys.exit(1)
PY
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  set +x
  t2_setup_handoff_cli "$@"
fi
