#!/usr/bin/env python3
"""Contract test for build-publish.yml's manual hotfix mode.

A dispatch on main with `hotfix_images` set builds only the named images,
tags them sha-<7> only (never :latest) and never notifies the infra repo.

The workflow is read with PyYAML because OSS runners have no yq. Step `env:`
maps and `if:` expressions are asserted by exact string. The `run:` bodies of
the new steps are executed with `bash -e` (the runner's default shell for a
`run:` without `shell:`). Each body gets only its declared env, with values
chosen by the test, plus the runner-provided PATH, GITHUB_OUTPUT and
GITHUB_SHA. An executed body may not contain an inline `${{ }}` expression,
so free text such as `hotfix_images` reaches the shell only through env.
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

sys.dont_write_bytecode = True

try:
    import yaml
except ImportError:
    print("FAIL: PyYAML is required (python3 -m pip install --user pyyaml)")
    sys.exit(2)


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_REL = ".github/workflows/build-publish.yml"
WORKFLOW = ROOT / WORKFLOW_REL
CI_PUBLIC = ROOT / ".github/workflows/ci-public.yml"
TEST_REL = "scripts/tests/test-build-publish-hotfix-mode.py"

HOTFIX_DESCRIPTION = (
    "Hotfix build on main only: space/comma-separated matrix image names. "
    "Builds just these, tags sha-<7> only (no :latest), never dispatches infra."
)
HOTFIX_EXPR = "${{ inputs.hotfix_images }}"
SELECT_GATE = "${{ steps.select.outputs.build == 'true' }}"
VALIDATE_IF = "${{ github.event_name == 'workflow_dispatch' }}"
VALIDATE_ENV = {
    "REF": "${{ github.ref }}",
    "BUILD_ALL": "${{ inputs.build_all }}",
    "HOTFIX_IMAGES": HOTFIX_EXPR,
    "WORKFLOW": WORKFLOW_REL,
}
KNOWN_IMAGES_PIPELINE = (
    "awk '/^  build-push:/,/^  merge:/' \"$WORKFLOW\" | sed -n 's/^ *- image: *//p'"
)
SELECT_ENV = {
    "HOTFIX_IMAGES": HOTFIX_EXPR,
    "IMAGE": "${{ matrix.image }}",
    "CHANGED": "${{ matrix.changed }}",
    "FORCE_ALL": "${{ needs.detect.outputs.force_all }}",
}
TAG_STEP = "Create the manifest list"
TAG_ENV = {
    "IMG_REF": "${{ env.REGISTRY }}/${{ env.NAMESPACE }}/${{ matrix.image }}",
    "SHORT_SHA": "${{ steps.shortsha.outputs.sha }}",
    "HOTFIX_IMAGES": HOTFIX_EXPR,
}
NOTIFY_IF = (
    "${{ !inputs.hotfix_images && "
    "(github.event_name != 'workflow_dispatch' || inputs.build_all) }}"
)
PYYAML_GUARD = (
    "python3 -c 'import yaml' 2>/dev/null || python3 -m pip install --user --quiet pyyaml"
)
FAKE_SHA = "0123456789abcdef0123456789abcdef01234567"
GATED_JOBS = ("build-push", "merge")


class CaseFailure(Exception):
    pass


def check(condition: bool, message: str) -> None:
    if not condition:
        raise CaseFailure(message)


def load(path: Path) -> dict:
    with open(path, encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


WF = load(WORKFLOW)
CI = load(CI_PUBLIC)


def jobs(doc: dict) -> dict:
    return doc.get("jobs") or {}


def steps_of(doc: dict, job: str) -> list:
    return (jobs(doc).get(job) or {}).get("steps") or []


def find_step(job: str, name: str) -> dict | None:
    for step in steps_of(WF, job):
        if step.get("name") == name:
            return step
    return None


def require_step(job: str, name: str) -> dict:
    step = find_step(job, name)
    check(step is not None, f"job {job} has no step named {name!r}")
    return step


def dispatch_inputs() -> dict:
    # PyYAML (YAML 1.1) reads the bare `on:` key as boolean True.
    trigger = WF.get("on") if "on" in WF else WF.get(True)
    return ((trigger or {}).get("workflow_dispatch") or {}).get("inputs") or {}


def run_step(step: dict, values: dict, path_prefix: str | None = None):
    """Run a step's `run:` body with only its declared env, valued by the test."""
    declared = step.get("env") or {}
    check(
        set(values) == set(declared),
        f"test values {sorted(values)} must cover exactly the declared env {sorted(declared)}",
    )
    body = step.get("run")
    check(isinstance(body, str) and body.strip() != "", f"step {step.get('name')!r} has no run body")
    check("${{" not in body, f"run body of {step.get('name')!r} contains an inline ${{{{ }}}} expression")
    with tempfile.TemporaryDirectory() as workdir:
        output_file = Path(workdir) / "github_output"
        output_file.write_text("", encoding="utf-8")
        script = Path(workdir) / "step.sh"
        script.write_text(body, encoding="utf-8")
        env = dict(values)
        runner_path = os.environ.get("PATH", "/usr/bin:/bin")
        env["PATH"] = f"{path_prefix}:{runner_path}" if path_prefix else runner_path
        env["GITHUB_OUTPUT"] = str(output_file)
        env["GITHUB_SHA"] = FAKE_SHA
        proc = subprocess.run(
            ["bash", "-e", str(script)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        outputs = {}
        for line in output_file.read_text(encoding="utf-8").splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                outputs[key] = value
    return proc.returncode, proc.stdout + proc.stderr, outputs


def matrix_include_images(job: str) -> list:
    matrix = ((jobs(WF).get(job) or {}).get("strategy") or {}).get("matrix") or {}
    return [entry.get("image") for entry in matrix.get("include") or []]


def matrix_images() -> list:
    images = matrix_include_images("build-push")
    check(len(images) >= 28, f"build-push matrix include lists only {len(images)} images")
    return images


# ─── input ──────────────────────────────────────────────────────────────────


def case_input_declared() -> None:
    inputs = dispatch_inputs()
    got = inputs.get("hotfix_images")
    want = {"description": HOTFIX_DESCRIPTION, "type": "string", "default": ""}
    check(got == want, f"hotfix_images input: want {want!r}, got {got!r}")
    build_all = inputs.get("build_all") or {}
    check(
        build_all.get("type") == "boolean" and build_all.get("default") is False,
        f"build_all input changed: {build_all!r}",
    )


def case_hotfix_input_only_via_env() -> None:
    offenders = []
    for job_name, job in jobs(WF).items():
        for index, step in enumerate(job.get("steps") or []):
            label = f"{job_name}/{step.get('name') or step.get('uses') or index}"
            if "inputs.hotfix_images" in str(step.get("run") or ""):
                offenders.append(f"{label} run")
            if "inputs.hotfix_images" in str(step.get("with") or ""):
                offenders.append(f"{label} with")
    check(not offenders, f"hotfix_images must reach steps only through env: {offenders}")


# ─── detect: Validate manual run ────────────────────────────────────────────


def run_validate(ref: str, build_all: str, hotfix: str):
    step = require_step("detect", "Validate manual run")
    return run_step(
        step,
        {
            "REF": ref,
            "BUILD_ALL": build_all,
            "HOTFIX_IMAGES": hotfix,
            "WORKFLOW": WORKFLOW_REL,
        },
    )


def expect_refused(ref: str, build_all: str, hotfix: str, mention: str | None = None) -> None:
    rc, out, _ = run_validate(ref, build_all, hotfix)
    case = f"REF={ref} BUILD_ALL={build_all} HOTFIX_IMAGES={hotfix!r}"
    check(rc == 1, f"{case}: want exit 1, got {rc}: {out.strip()}")
    check("::error::" in out, f"{case}: refusal must print ::error::, got: {out.strip()}")
    if mention is not None:
        check(mention in out, f"{case}: refusal must name {mention!r}, got: {out.strip()}")


def expect_accepted(ref: str, build_all: str, hotfix: str) -> None:
    rc, out, _ = run_validate(ref, build_all, hotfix)
    case = f"REF={ref} BUILD_ALL={build_all} HOTFIX_IMAGES={hotfix!r}"
    check(rc == 0, f"{case}: want exit 0, got {rc}: {out.strip()}")
    check("::error::" not in out, f"{case}: accepted run printed an error: {out.strip()}")


def case_validate_env_exact() -> None:
    step = require_step("detect", "Validate manual run")
    detect_steps = steps_of(WF, "detect")
    names = [s.get("name") or s.get("uses") for s in detect_steps]
    # Right after checkout (it reads the workflow file) and above "Resolve
    # build mode". It cannot follow the filter step: test-images-manifest.sh
    # parses `filters:` through the blank line before `  build-push:`.
    check(
        len(detect_steps) >= 3
        and str(detect_steps[0].get("uses", "")).startswith("actions/checkout@")
        and detect_steps[1] is step
        and detect_steps[2].get("name") == "Resolve build mode"
        and detect_steps[-1].get("name") == "Detect changed paths",
        f"detect steps must be checkout, Validate manual run, Resolve build mode, ..., "
        f"Detect changed paths; got {names}",
    )
    check(step.get("if") == VALIDATE_IF, f"validate if: want {VALIDATE_IF!r}, got {step.get('if')!r}")
    check(step.get("env") == VALIDATE_ENV, f"validate env: want {VALIDATE_ENV!r}, got {step.get('env')!r}")
    check("${{" not in str(step.get("run")), "validate run body contains an inline ${{ }} expression")


def case_validate_never_soft_fails() -> None:
    step = require_step("detect", "Validate manual run")
    check(
        "continue-on-error" not in step,
        f"Validate manual run must fail detect, never continue on error: {step.get('continue-on-error')!r}",
    )


def case_validate_known_list_matches_matrix() -> None:
    step = require_step("detect", "Validate manual run")
    check(
        KNOWN_IMAGES_PIPELINE in str(step.get("run")),
        f"validate must read the known images with: {KNOWN_IMAGES_PIPELINE}",
    )
    proc = subprocess.run(
        ["bash", "-c", f"set -euo pipefail; {KNOWN_IMAGES_PIPELINE}"],
        cwd=ROOT,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "WORKFLOW": WORKFLOW_REL},
        capture_output=True,
        text=True,
        timeout=30,
    )
    check(proc.returncode == 0, f"known-images pipeline failed: {proc.stderr.strip()}")
    from_awk = proc.stdout.split()
    include = matrix_images()
    check(from_awk == include, f"awk list {from_awk} != PyYAML build-push include {include}")
    dimension = ((jobs(WF)["build-push"].get("strategy") or {}).get("matrix") or {}).get("image")
    check(from_awk == dimension, f"awk list {from_awk} != build-push image dimension {dimension}")
    merge_include = matrix_include_images("merge")
    check(from_awk == merge_include, f"awk list {from_awk} != merge include {merge_include}")


def case_validate_rejects_bare_main() -> None:
    expect_refused("refs/heads/main", "false", "")


def case_validate_rejects_dev_ref_hotfix() -> None:
    expect_refused("refs/heads/dev", "false", "control-ui")
    expect_refused("refs/heads/feat/some-branch", "false", "control-ui")
    # The ref must be main exactly, not a branch whose name starts with main.
    expect_refused("refs/heads/main-x", "false", "control-ui", mention="not refs/heads/main-x")


def case_validate_rejects_build_all_with_hotfix() -> None:
    expect_refused("refs/heads/main", "true", "control-ui")


def case_validate_rejects_unknown_image() -> None:
    expect_refused("refs/heads/main", "false", "control-ui, not-an-image", mention="not-an-image")
    # A prefix of a real image is still unknown.
    expect_refused("refs/heads/main", "false", "mcp-hos", mention="mcp-hos")


def case_validate_rejects_duplicate() -> None:
    expect_refused("refs/heads/main", "false", "control-ui,control-ui", mention="control-ui")
    expect_refused("refs/heads/main", "false", "control-ui, profile-ui control-ui", mention="control-ui")


def case_validate_rejects_bad_charset() -> None:
    for value in ("Control-UI", "control-ui;id", "control-ui\nprofile-ui", "*", "control-ui\tprofile-ui"):
        expect_refused("refs/heads/main", "false", value)


def case_validate_rejects_empty_list() -> None:
    for value in (",", " , ", "   "):
        expect_refused("refs/heads/main", "false", value)


def case_validate_accepts_commas() -> None:
    for value in (
        "control-ui, profile-ui",
        "control-ui,profile-ui",
        " control-ui  profile-ui ",
        "mcp-host,mcp-host-slim",
    ):
        expect_accepted("refs/heads/main", "false", value)
    expect_accepted("refs/heads/main", "false", ", ".join(matrix_images()))


def case_validate_allows_dev_build_all() -> None:
    expect_accepted("refs/heads/dev", "true", "")
    # The full-rebuild escape hatch on main stays available.
    expect_accepted("refs/heads/main", "true", "")


# ─── build-push / merge: Select this image ──────────────────────────────────


def select_step(job: str) -> dict:
    steps = steps_of(WF, job)
    check(bool(steps), f"job {job} has no steps")
    first = steps[0]
    check(
        first.get("name") == "Select this image" and first.get("id") == "select",
        f"first step of {job} must be 'Select this image' (id: select), got {first.get('name')!r}",
    )
    return first


def run_select(job: str, hotfix: str, image: str, changed: str, force_all: str) -> str:
    step = select_step(job)
    rc, out, outputs = run_step(
        step,
        {"HOTFIX_IMAGES": hotfix, "IMAGE": image, "CHANGED": changed, "FORCE_ALL": force_all},
    )
    case = f"{job}: HOTFIX_IMAGES={hotfix!r} IMAGE={image} CHANGED={changed!r} FORCE_ALL={force_all!r}"
    check(rc == 0, f"{case}: select exited {rc}: {out.strip()}")
    check("build" in outputs, f"{case}: select wrote no build output")
    return outputs["build"]


def expect_select(hotfix: str, image: str, changed: str, force_all: str, want: str) -> None:
    for job in GATED_JOBS:
        got = run_select(job, hotfix, image, changed, force_all)
        check(
            got == want,
            f"{job}: HOTFIX_IMAGES={hotfix!r} IMAGE={image} CHANGED={changed!r} "
            f"FORCE_ALL={force_all!r}: want build={want}, got build={got}",
        )


def case_select_env_exact() -> None:
    bodies = []
    for job in GATED_JOBS:
        step = select_step(job)
        check("if" not in step, f"{job} select step must not be gated itself")
        check(step.get("env") == SELECT_ENV, f"{job} select env: want {SELECT_ENV!r}, got {step.get('env')!r}")
        bodies.append(step.get("run"))
    check(bodies[0] == bodies[1], "build-push and merge must run the same select body")


def case_select_hotfix_in_list() -> None:
    expect_select("control-ui, profile-ui", "profile-ui", "true", "true", "true")
    expect_select("control-ui, profile-ui", "control-ui", "true", "true", "true")
    # Membership alone decides, even for an image change detection skipped.
    expect_select("control-ui,profile-ui", "profile-ui", "false", "false", "true")


def case_select_hotfix_not_in_list() -> None:
    expect_select("control-ui, profile-ui", "mcp-host", "true", "true", "false")
    # mcp-host is a prefix of mcp-host-slim; only an exact name selects, either way round.
    expect_select("mcp-host-slim", "mcp-host", "true", "true", "false")
    expect_select("mcp-host", "mcp-host-slim", "true", "true", "false")


def case_select_normal_changed() -> None:
    expect_select("", "control-ui", "true", "false", "true")
    # Full build (build_all, or no push base): the filter is skipped, so
    # matrix.changed is empty and force_all decides.
    expect_select("", "control-ui", "", "true", "true")


def case_select_normal_unchanged() -> None:
    expect_select("", "control-ui", "false", "false", "false")
    expect_select("", "control-ui", "", "false", "false")


def case_gated_jobs_need_detect() -> None:
    # A job-level `if` (e.g. always()) would run build-push or merge after a
    # failed "Validate manual run"; needing detect is what stops them.
    for job in GATED_JOBS:
        spec = jobs(WF).get(job) or {}
        check("if" not in spec, f"{job} must have no job-level if (got {spec.get('if')!r})")
        needs = spec.get("needs")
        needs = [needs] if isinstance(needs, str) else list(needs or [])
        check("detect" in needs, f"{job} must need detect (got {spec.get('needs')!r})")


def case_all_steps_gated_on_select() -> None:
    offenders = []
    for job in GATED_JOBS:
        select_step(job)
        for index, step in enumerate(steps_of(WF, job)[1:], start=1):
            if step.get("if") != SELECT_GATE:
                label = step.get("name") or step.get("uses") or index
                offenders.append(f"{job}/{label}: {step.get('if')!r}")
    check(not offenders, f"every non-select step must use exactly {SELECT_GATE!r}: {offenders}")


def case_push_builds_dev_only() -> None:
    # A push to main never builds; a bare manual run on main is refused in validate.
    trigger = WF.get("on") if "on" in WF else WF.get(True)
    branches = ((trigger or {}).get("push") or {}).get("branches")
    check(branches == ["dev"], f"build-publish must build on push to dev only, got branches {branches!r}")


# ─── merge: tags ────────────────────────────────────────────────────────────


def case_tag_env_exact() -> None:
    step = require_step("merge", TAG_STEP)
    check(step.get("env") == TAG_ENV, f"tag step env: want {TAG_ENV!r}, got {step.get('env')!r}")
    check("${{" not in str(step.get("run")), "tag step run body contains an inline ${{ }} expression")


def run_tag_step(hotfix: str) -> tuple[list, str]:
    """Run the manifest-list body against a docker stub; return (argv, image ref)."""
    step = require_step("merge", TAG_STEP)
    image = f"hotfix-mode-test-{uuid.uuid4().hex[:12]}"
    img_ref = f"ghcr.io/evenfire-ai/{image}"
    # The body reads the per-arch digests from /tmp/digests by image name; a
    # unique fake image name keeps these files apart from anything else there.
    digests = Path("/tmp/digests")
    created_dir = not digests.exists()
    digests.mkdir(parents=True, exist_ok=True)
    amd64 = digests / f"{image}-amd64"
    arm64 = digests / f"{image}-arm64"
    amd64.write_text("sha256:" + "a" * 64, encoding="utf-8")
    arm64.write_text("sha256:" + "b" * 64, encoding="utf-8")
    try:
        with tempfile.TemporaryDirectory() as stub_dir:
            docker = Path(stub_dir) / "docker"
            docker.write_text('#!/bin/sh\nfor arg in "$@"; do printf \'ARGV:%s\\n\' "$arg"; done\n', encoding="utf-8")
            docker.chmod(0o755)
            rc, out, _ = run_step(
                step,
                {"IMG_REF": img_ref, "SHORT_SHA": "abc1234", "HOTFIX_IMAGES": hotfix},
                path_prefix=stub_dir,
            )
    finally:
        amd64.unlink(missing_ok=True)
        arm64.unlink(missing_ok=True)
        if created_dir:
            try:
                digests.rmdir()
            except OSError:
                pass
    check(rc == 0, f"tag step exited {rc}: {out.strip()}")
    argv = [line[len("ARGV:"):] for line in out.splitlines() if line.startswith("ARGV:")]
    check(argv[:3] == ["buildx", "imagetools", "create"], f"unexpected docker argv: {argv}")
    return argv, img_ref


def flag_values(argv: list, flag: str) -> list:
    return [argv[i + 1] for i, arg in enumerate(argv[:-1]) if arg == flag]


def check_common_tag_args(argv: list, img_ref: str) -> None:
    tags = flag_values(argv, "-t")
    check(f"{img_ref}:sha-abc1234" in tags, f"sha-<7> tag missing: {argv}")
    annotations = flag_values(argv, "--annotation")
    want_annotation = f"index:org.opencontainers.image.revision={FAKE_SHA}"
    check(want_annotation in annotations, f"revision annotation missing: {argv}")
    check(f"{img_ref}@sha256:{'a' * 64}" in argv, f"amd64 source missing: {argv}")
    check(f"{img_ref}@sha256:{'b' * 64}" in argv, f"arm64 source missing: {argv}")


def case_latest_skipped_in_hotfix() -> None:
    argv, img_ref = run_tag_step("control-ui, profile-ui")
    check_common_tag_args(argv, img_ref)
    check(not any(arg.endswith(":latest") for arg in argv), f"hotfix run must not push :latest: {argv}")
    check(flag_values(argv, "-t") == [f"{img_ref}:sha-abc1234"], f"hotfix run must push sha-<7> only: {argv}")


def case_latest_present_normally() -> None:
    argv, img_ref = run_tag_step("")
    check_common_tag_args(argv, img_ref)
    check(f"{img_ref}:latest" in flag_values(argv, "-t"), f"normal run must push :latest: {argv}")


# ─── notify-infra ───────────────────────────────────────────────────────────


def case_notify_if_exact() -> None:
    job = jobs(WF).get("notify-infra") or {}
    check(job.get("if") == NOTIFY_IF, f"notify-infra if: want {NOTIFY_IF!r}, got {job.get('if')!r}")
    check(job.get("needs") == "merge", f"notify-infra must still need merge, got {job.get('needs')!r}")


# ─── ci-public.yml ──────────────────────────────────────────────────────────


def case_ci_public_runs_test() -> None:
    check((ROOT / TEST_REL).is_file(), f"{TEST_REL} is missing")
    for job_name, job in jobs(CI).items():
        steps = job.get("steps") or []
        for index, step in enumerate(steps):
            if (step.get("run") or "").strip() != "bash scripts/tests/test-images-manifest.sh":
                continue
            check(index + 1 < len(steps), f"{job_name}: no step after test-images-manifest.sh")
            nxt = steps[index + 1]
            lines = [line.strip() for line in (nxt.get("run") or "").strip().splitlines()]
            want = [PYYAML_GUARD, f"python3 {TEST_REL}"]
            check(
                lines == want,
                f"{job_name}: the step after test-images-manifest.sh must run {want}, got {lines}",
            )
            return
    raise CaseFailure("ci-public.yml has no test-images-manifest.sh step")


CASES = [
    ("input_declared", case_input_declared),
    ("hotfix_input_only_via_env", case_hotfix_input_only_via_env),
    ("validate_env_exact", case_validate_env_exact),
    ("validate_never_soft_fails", case_validate_never_soft_fails),
    ("validate_known_list_matches_matrix", case_validate_known_list_matches_matrix),
    ("validate_rejects_bare_main", case_validate_rejects_bare_main),
    ("validate_rejects_dev_ref_hotfix", case_validate_rejects_dev_ref_hotfix),
    ("validate_rejects_build_all_with_hotfix", case_validate_rejects_build_all_with_hotfix),
    ("validate_rejects_unknown_image", case_validate_rejects_unknown_image),
    ("validate_rejects_duplicate", case_validate_rejects_duplicate),
    ("validate_rejects_bad_charset", case_validate_rejects_bad_charset),
    ("validate_rejects_empty_list", case_validate_rejects_empty_list),
    ("validate_accepts_commas", case_validate_accepts_commas),
    ("validate_allows_dev_build_all", case_validate_allows_dev_build_all),
    ("select_env_exact", case_select_env_exact),
    ("select_hotfix_in_list", case_select_hotfix_in_list),
    ("select_hotfix_not_in_list", case_select_hotfix_not_in_list),
    ("select_normal_changed", case_select_normal_changed),
    ("select_normal_unchanged", case_select_normal_unchanged),
    ("gated_jobs_need_detect", case_gated_jobs_need_detect),
    ("push_builds_dev_only", case_push_builds_dev_only),
    ("all_steps_gated_on_select", case_all_steps_gated_on_select),
    ("tag_env_exact", case_tag_env_exact),
    ("latest_skipped_in_hotfix", case_latest_skipped_in_hotfix),
    ("latest_present_normally", case_latest_present_normally),
    ("notify_if_exact", case_notify_if_exact),
    ("ci_public_runs_test", case_ci_public_runs_test),
]


def main() -> int:
    registered = {fn for _, fn in CASES}
    defined = {fn for name, fn in globals().items() if name.startswith("case_") and callable(fn)}
    failed = []
    for name, fn in CASES:
        try:
            fn()
        except CaseFailure as err:
            failed.append(name)
            print(f"FAIL: {name}: {err}")
        except Exception as err:  # noqa: BLE001 - report, keep running the rest
            failed.append(name)
            print(f"FAIL: {name}: unexpected {type(err).__name__}: {err}")
        else:
            print(f"PASS: {name}")
    unregistered = sorted(fn.__name__ for fn in defined - registered)
    if unregistered:
        failed.append("every case_ function is registered")
        print(f"FAIL: every case_ function is registered: {unregistered}")
    else:
        print("PASS: every case_ function is registered")
    print(f"{len(CASES) + 1 - len(failed)}/{len(CASES) + 1} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
