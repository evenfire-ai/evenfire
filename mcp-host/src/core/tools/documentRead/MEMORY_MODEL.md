# Memory-protection model of the document reader

Scope: what stops a hostile or merely huge PDF/XLSX from taking the Host
process down, which parts are hard guarantees, and what is left. Written for
review round 2, R1-H4 ("the cgroup OOM can still beat the parent's kill"),
which asked for a design note instead of a fourth patch in `workerRunner.ts`.

## Threat

The reader parses untrusted bytes in a child process. The child shares the
Host container's cgroup (512 MiB `memory.max` by default). If the container's
memory reaches `memory.max`, the kernel OOM killer fires. Where
`memory.oom.group=1` it kills every process of the container, Host included.
Kubelet sets that for every container on cgroup v2 since Kubernetes 1.28; only
kubelet `singleProcessOOMKill: true` (Kubernetes 1.32+, a node-wide setting)
turns it off. So the question is not "does the child die" but "can the
container reach `memory.max` before the child is stopped".

## Layers, from the document outward

| #   | Layer                                       | Where                                                              | Kind                                       | What it bounds                                                                                                                                                                                                      |
| --- | ------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Source and inflate limits                   | `zipLimits.ts`, `xlsxParser.ts` (`InflatedCounter`), pdfjs options | deterministic, in the child                | bytes the parsers may inflate or decode                                                                                                                                                                             |
| 2   | V8 heap                                     | `--max-old-space-size=maxHeapMb`                                   | deterministic, in the child                | JS heap; not Buffers, pdfjs/canvas native memory or decoded images                                                                                                                                                  |
| 3   | **`RLIMIT_DATA`**                           | `workerSpawnCommand`: `ulimit -d` then `exec`                      | **kernel-enforced hard limit**             | the child's private writable address space: `maxResidentBytes + childVirtualReserveBytes(arch)`                                                                                                                     |
| 4   | Admission                                   | `effectiveDocumentMemoryCaps`                                      | computed per job from the cgroup           | `maxResidentBytes = min(configured, memory.max - working set - 64 MiB margin - 113 MiB IPC reserve - 128 MiB drift reserve)`; below 128 MiB resident or 64 MiB heap the job is refused as `host_memory_unavailable` |
| 5   | Parent sampler                              | `workerRunner.ts` `sample()` every 25 ms                           | best-effort, racy by construction          | kills the child when its RSS passes the cap, or when the cgroup working set is within 64 MiB of `memory.max`                                                                                                        |
| 6   | OOM victim mark                             | `oomScore.ts`: `oom_score_adj=1000` before the job is sent         | best-effort, no effect under `oom.group=1` | which process the kernel picks when `oom.group=0`                                                                                                                                                                   |
| 7   | One job at a time, 30 s timeout, output cap | `workerRunner.ts`                                                  | deterministic                              | concurrency, wall time, bytes crossing the IPC boundary                                                                                                                                                             |

Layer 3 is what changed the model. Before it, layers 2, 5 and 6 were the only
fences, and layer 5 is a sample: the reviewer measured jumps of 209 MiB
(inflated text PDF) and 288 MiB (inflated workbook) between two 25 ms samples,
against a 64 MiB margin. With `RLIMIT_DATA` the allocation fails inside the
child (`ERR_MEMORY_ALLOCATION_FAILED`, `RangeError: Array buffer allocation
failed`, or a V8 abort), the worker maps it to `limit: heap`, and nothing waits
on a sample. A local check on the box used for this round (Linux 6.12, Node 24.22): `ulimit -d 3000000` then allocating 32 MiB buffers in a loop fails with
a catchable `Failed to allocate memory` after 2336 MiB of buffers, not with a signal.

### Why `RLIMIT_DATA` and not `RLIMIT_AS`

V8 reserves a large virtual range up front (the code range and pointer cage),
so `RLIMIT_AS` would have to admit gigabytes of address space that is never
resident, and then bounds nothing useful. `RLIMIT_DATA` counts private writable
mappings, which is what Buffers, ArrayBuffers and malloc'd native memory are,
and it includes the same V8 reservations. They are a constant, so the limit is
set as `resident cap + V`, where `V` is the child's idle VmData measured per
architecture (x64 1963 MiB, arm64 1282 MiB, plus a 128 MiB drift reserve).
An architecture without a measurement refuses to spawn rather than guess.
`ignore_rlimit_data=Y` (a kernel module parameter) would silently disable the
limit, so it is read on every job and an unreadable value fails closed.

## What is a guarantee, and what is not

Guaranteed, if layer 3 is enforced (the runner checks the parameter and the
architecture on every job): the child's private memory cannot grow past
`maxResidentBytes + V`, whatever the document does and however fast it does it.

Not covered by `RLIMIT_DATA`:

- shared and file-backed mappings of the child (shmem, memfd, the mapped
  binary and libraries), thread stacks, kernel memory attributed to the cgroup
  (socket and pipe buffers of the IPC channel, page tables). The child does not
  create shared memory itself, and the IPC buffers are bounded by the output cap.
- **The Host's own growth while a job runs.** Admission subtracts the Host's
  working set at the start, a 64 MiB margin, a 113 MiB reserve for the Host-side
  copies of one job (source decode, job serialization, outcome, re-serialization,
  base64 of a 20 MiB PNG) and a 128 MiB drift reserve. The 113 MiB figure is an
  estimate from the specified caps, not a measurement. If the Host grows by more
  than what is left of those reserves while the child is at its cap, the
  container reaches `memory.max`. Layer 5 then helps only if its sample lands
  in time.
- a wrong calibration. `V` was measured in one pinned image
  (`node:24.16.0-alpine`) and on arm64 (amd64 through Rosetta). A changed Node,
  libc or `@napi-rs/canvas` build can move idle VmData. Too small: legitimate
  reads fail with a `heap` outcome. Too large: the resident bound is weaker by
  the excess. CI on amd64 (G1) is the durable check; the
  `childVmDataBytes` field of the `document reader job finished` log line is the
  production signal to watch.

So the residual risk is "Host + child together reach `memory.max`" and not "one
document can". Under `oom.group=0` that outcome kills the child first (layer 6).
Under `oom.group=1` it kills the container.

## Delegated sub-cgroup with its own `memory.max` (evaluated, not implemented)

This is the only mechanism that removes the residual completely: an OOM inside
a child cgroup kills only that cgroup, whatever `oom.group` says for the parent,
and the Host's own growth is not charged to the child's limit. It was evaluated
and cannot be done from this process without platform changes:

- Creating a cgroup needs write access to a delegated cgroup directory. Container
  runtimes normally mount the cgroup filesystem read-only for an unprivileged
  container and do not delegate the container's cgroup to its process UID; the
  T2 profile's cgroup topology was only read (`0::/`, `memory.max` 512 MiB),
  not tested for writes. On the box used for this round (also cgroup v2)
  `/sys/fs/cgroup/agent` is `root:root 0755` and the process runs as uid 1000,
  so a `mkdir` there is refused by permissions.
- cgroup v2's no-internal-process rule means the controller can only be enabled
  for children in a cgroup whose own tasks have been moved out, so the Host
  would have to relocate itself into a leaf, which is an operator or init
  change, not something the reader can do safely at runtime.
- A fail-safe fallback is possible in code (try to create the cgroup, and keep
  layers 3-6 when it is refused), but then the mechanism would be exercised only
  on nodes that grant delegation, with no test here that can cover it. A path
  that cannot be tested in CI is not added in this PR.

Cluster work that would make it possible: run the Host with a delegated
`cgroup.subtree_control` (for example a writable cgroup namespace for a
dedicated reader sidecar or init-moved Host), or run the reader as a separate
container with its own memory limit so that its OOM is a container OOM.

## Required cluster configuration and what to tell operators

1. Linux with a unified cgroup v2 memory controller (`0::/`, readable
   `memory.max`, `memory.current`, `memory.stat`). v1, a missing or malformed
   controller fails closed as `host_memory_unavailable`.
2. `/sys/module/kernel/parameters/ignore_rlimit_data` readable and `N`.
3. A calibrated architecture (x64 or arm64).
4. To keep a combined Host+child overrun from taking the container down:
   kubelet `singleProcessOOMKill: true` (Kubernetes 1.32+) so the kernel
   kills only the highest-scored process, which is the child. Without it,
   treat a combined overrun as a possible container restart.
5. Size the Host container so that `memory.max` leaves room beyond the Host's
   steady working set plus the reserves above; admission refuses reads rather
   than starting them in a tight container, so a small container shows up as
   `host_memory_unavailable`, not as an OOM.

## Claim for the PR description

Replace "running out of memory returns `document_limits_exceeded` / `heap`
without touching the Host process" with: "The child's private memory is capped
by `RLIMIT_DATA` (resident cap plus a calibrated virtual reserve), so an
oversized document fails an allocation inside the child and returns
`document_limits_exceeded` / `heap`. The parent also samples the child and the
container and kills the child early. This protects the Host from the document,
not from the Host's own concurrent growth: if Host and child together reach the
container limit, the kernel OOM killer runs. With `memory.oom.group=1` (the
Kubernetes 1.28+ default on cgroup v2) that restarts the container; set kubelet
`singleProcessOOMKill: true` to make the child the only victim."

## Tests that pin this model

- `__tests__/documentMemory.test.ts`: admission arithmetic (working set,
  margin, reserves, floors), reserve per architecture.
- `__tests__/workerRunner.test.ts`, `__tests__/workerMemoryQueue.test.ts`:
  `ulimit -d` command shape, fail-closed on `ignore_rlimit_data`, the mark
  before the job, the sampler kills, slot release.
- `__tests__/memoryLimits.test.ts`: real children against an inflated PDF
  stream, an inflated workbook, forged ZIP sizes. These tests start the child
  through a TypeScript transpiler, so on a host whose idle child RSS is above
  the 256 MiB caps they use, they fail for that reason alone (three did on the
  box used for this round, whose child idles near 270 MiB).
