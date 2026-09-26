# Local measurement base and unit-test coverage

Run a benchmark from the intended Evenfire checkout through the intake gate:

```bash
bash scripts/dev/repo-intake-packet.sh --measure -- <benchmark-command> [arguments...]
```

The gate records full HEAD and base commits, dirty-file count and ancestry.
It refuses to start the command when `origin/dev` is missing, has commits
absent from HEAD, HEAD is detached, merge conflicts exist, or `git status`
cannot be read. Candidate edits are allowed and reported. A blocked gate exits
2 and prints `measurement_readiness: blocked` with its `blockers`; otherwise it
prints `measurement_readiness: base_check_passed_not_a_lane_verdict` and
replaces itself with the command, so the command's exit status is returned
unchanged.
This uses the locally recorded `origin/dev`; it does not fetch, update a
branch, inspect a cluster, or certify T0/T1/T2. Refresh the remote reference
through the normal repository workflow before measuring against current dev.
`REPO_INTAKE_BASE_REF` cannot override the measurement default.

For an intentional historical comparison, pin the base explicitly:

```bash
bash scripts/dev/repo-intake-packet.sh --measure --historical-base <commit> -- <benchmark-command> [arguments...]
```

That base must exist and be an ancestor of HEAD. Detached HEAD is allowed in
this mode; output is marked `historical_non_certifying`. This option does not
relax the normal T2 intake or certify runtime evidence. Start benchmarks
through this gate; calling one directly skips the base check.

`make test-service-matrix` compares the expanded `TEST_SERVICES` list with the
literal service matrix of the `test` job in `.github/workflows/ci-public.yml`
(`strategy.matrix.service`). It rejects omissions, extra entries, duplicates
and unsupported matrix shapes, and runs before `make test-unit-all` executes
packages. Each package keeps its `npm test` semantics; real PostgreSQL tests
remain opt-in and are not T1 evidence in this unit lane.

## AutoResearch hard-gate entrypoints

Use `scripts/dev/autoresearch-benchmark.sh -- <benchmark-command>` as the
AutoResearch benchmark command. It runs the measurement intake first, so a
missing or stale `origin/dev`, default detached HEAD, or merge conflict blocks
the benchmark before it starts. A passing intake emits
`AUTORESEARCH_GATE branch_freshness=pass`.

Configure `make autoresearch-checks` as AutoResearch's `--checks-command`.
It runs the CI/Makefile service-matrix parity check and emits
`AUTORESEARCH_GATE service_matrix_parity=pass`. The Ralph adapter maps a
non-zero checks command to the packet's `tests_pass` hard gate, so service
drift cannot be kept. The captured gate lines make the two reasons explicit
in packet evidence.

These entrypoints use only the current local checkout and locally recorded Git
refs. They do not fetch, push, create commits, change Minikube/Kubernetes
state, or publish AutoResearch session files; the ignored `autoresearch.*`
files remain local unless deliberately copied elsewhere.

CI runs these contract checks in the `shell-syntax` job; locally (no cluster
required):

```bash
node scripts/tests/run-node-test-files.mjs scripts/tests/test-test-services.cjs scripts/tests/test-measurement-base.cjs
bash scripts/tests/test-repo-intake-packet.sh
bash scripts/tests/test-autoresearch-gates.sh
make test-service-matrix
make autoresearch-checks
```
