# Local measurement base and unit-test coverage

Run a benchmark from the intended Evenfire checkout through the intake gate:

```bash
bash scripts/dev/repo-intake-packet.sh --measure -- <benchmark-command> [arguments...]
```

The gate records full HEAD and base commits, dirty-file count and ancestry.
It refuses to start the command when `origin/dev` is missing, has commits
absent from HEAD, HEAD is detached, or merge conflicts exist. Candidate edits
are allowed and reported. The benchmark's exit status is preserved.
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
relax the normal T2 intake or certify runtime evidence. Use the gate as the
entry command of a future approved AutoResearch benchmark; calling a benchmark
directly bypasses it. No global runner or scheduled automation is changed.

`make test-service-matrix` compares the expanded `TEST_SERVICES` list with the
literal service matrix in CI. It rejects omissions, extra entries, duplicates
and unsupported matrix shapes before `make test-unit-all` executes packages.
CI remains unchanged. Each package keeps its existing `npm test` semantics;
real PostgreSQL tests remain opt-in and are not T1 evidence in this unit lane.

Local contract checks (no cluster required):

```bash
node --test scripts/tests/test-measurement-base.cjs scripts/tests/test-test-services.cjs
bash scripts/tests/test-repo-intake-packet.sh
make test-service-matrix
```
