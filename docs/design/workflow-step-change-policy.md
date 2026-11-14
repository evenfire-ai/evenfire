# Workflow step change policy and flags

> **Status:** Proposed. Section 5 lists the decisions that are still open.
>
> **Scope:** how changes to `WorkflowRecipe.spec.steps[]` and to step execution are introduced.
> This record states principles and policy. It does not propose new CRD fields; each feature
> brings its own fields with its own change.

Code references are `path:line` at `dev` commit `61f32ae` unless they name another commit.

---

## 1. Why this record exists

A step field travels through four hops before it has any effect:

1. the CRD schema (`charts/clerum-crds/crds/workflowrecipe.yaml`);
2. the per-field projection WRC writes into the coordinator ConfigMap
   (`workflow-recipes/src/workflow/workflowReconciler.ts:5568-5609`);
3. the parser of the built-in coordinator (`workflow-recipes/src/workflow/sdkRuntime.ts:566-606`);
   section 3 covers custom coordinator images;
4. the consumer: the request to mcp-host, the model injection request, the snippet runner
   request, or the coordinator itself.

A field can be accepted at hop 1 and silently dropped later. `steps[].agent.soul` is the
existing example: it is in the schema, projected and parsed, but the model injection request
carries only `stepId`, `provider` and `model`
(`workflow-recipes/src/workflow/sdkRuntime.ts:274-278`), so the persona never reaches the model.

Agentic steps also run on their own reduced loop, separate from the agent tool-use loop
(`mcp-host/src/workflow/workflowService.ts:523-527`), so a behaviour change there reaches every
recipe at once. Both facts call for explicit rules.

## 2. Principles

1. **A field exists in the CRD only together with the code that consumes it.** No schema-only
   changes.
2. **A change to how a step executes ships behind a flag** and can be undone by an operator
   without a code change.
3. **Parity before improvement.** When an execution path is replaced, the replacement first
   reproduces the current behaviour under deterministic replay tests; improvements follow one at
   a time, each with its own flag.
4. **Few CRD releases.** Helm does not update `crds/` on upgrade
   (`charts/clerum-crds/README.md:44-49`), so each CRD change costs a manual apply per cluster
   and a re-vendor in every consumer that pins the CRD. Field changes are grouped.
5. **Status reports carry structure, not payloads.** Tool arguments and results can echo
   secrets; new reports, new status fields and logs record names, sizes and references rather
   than content. The existing step status is the exception: it stores a bounded preview of the
   step output and of the reported tool calls' arguments and results, not redacted
   (`packages/workflow-runtime-core/src/status-reporter/toolCallStatus.ts:34-59` and
   `workflow-recipes/src/workflow/restEndpoints.ts:823-829`, at `dev` `1b1b1131e`). A
   replacement execution path reproduces those previews under principle 3. Reducing
   `toolsCalled[].args` and `.result` is open decision 8; the output preview stays, because
   coordinator resume reads it back as the input of later steps
   (`workflow-recipes/src/workflow/sdkRuntime.ts:195-203` at `61f32ae`).

## 3. Policy for unsupported fields

The rule of principle 1 is enforced at three layers.

1. **API server.** The schema is structural, so a cluster with an older CRD prunes a newer
   field without an error. Platform writers of `WorkflowRecipe` objects should request strict
   field validation so an unknown field is rejected instead of pruned.
2. **WRC.** The preflight validation
   (`workflow-recipes/src/workflow/workflowReconciler.ts:1759`) should reject, with a status
   condition, any field the running WRC knows but does not implement.
3. **Coordinator.** The step parser should reject unknown step keys, as it already does inside
   `run` (`workflow-recipes/src/workflow/sdkRuntime.ts:648`). Two parsers read the spec. The
   runtime-core `ConfigLoader` (`packages/workflow-runtime-core/src/config-loader/loader.ts:120-163`)
   runs in the built-in coordinator (`workflow-recipes/src/workflow/sdkRuntime.ts:116-118`) and in
   custom coordinator images that read the spec through `sdk.config.getSpec()`
   (`packages/workflow-sdk`, which re-exports it:
   `packages/workflow-sdk/src/config-loader/loader.ts:1`). Only the built-in coordinator then
   applies `parseRuntimeWorkflowSpec` (`workflow-recipes/src/workflow/sdkRuntime.ts:555-559`). A
   rejection that must hold for custom images therefore belongs in `ConfigLoader`; a custom image
   that reads the spec file with its own code is covered by layers 1 and 2 only.

A contract test keeps the layers aligned: it enumerates the step schema from the chart YAML and
fails when a field is not projected, not parsed or not consumed, unless the field is on an
explicit, justified exception list. For custom coordinator images it can check `ConfigLoader`
only, the parser they share with the built-in coordinator.

## 4. Flag policy

- **Precedence:** recipe-level setting where one exists, then operator environment on the WRC
  Deployment, then the default.
- WRC forwards a variable of its own environment to a recipe pod under the same name only when
  the variable is on the allowlist for that pod type. Three pod types have such a list:
  `MCP_HOST_ENV_PASSTHROUGH` (`workflow-recipes/src/workflow/podFactory.ts:78-83`),
  `COORDINATOR_ENV_PASSTHROUGH` (`workflow-recipes/src/workflow/podFactory.ts:90-93`) and
  `SNIPPET_RUNNER_ENV_PASSTHROUGH` (`workflow-recipes/src/workflow/podFactory.ts:99-102`). A flag
  read by mcp-host, where agentic steps run, must be on `MCP_HOST_ENV_PASSTHROUGH`. A flag is
  usable by operators only once it is on the list of the pod that reads it, so the allowlist
  change ships before the behaviour it controls.
  The snippet runner filters its environment once more before it forks the worker that runs
  snippet code: only `CLERUM_SNIPPET_SECRET_*` variables and the two names in
  `SNIPPET_WORKER_TIMEOUT_ENV_PASSTHROUGH` reach the worker
  (`workflow-recipes/src/workflow/snippetRuntime.ts:6-9`, `:80-89`), so a WRC variable read by
  snippet code must be on both lists.
- The effective execution path is recorded with the step result, so an outcome can be
  attributed to the code that produced it.
- Each flag is introduced with its removal criterion.
- New behaviour starts off, with one exception described below.

The flags in the table are proposed. At `dev` `1b1b1131e` all four names are on
`MCP_HOST_ENV_PASSTHROUGH` (`workflow-recipes/src/workflow/podFactory.ts:83-86`) and no code
reads them yet; step spillover itself is a separate change (#1454). What this section says about
them describes intended behaviour.

| Flag                                          | Values           | Default    | Purpose                                                                             |
| --------------------------------------------- | ---------------- | ---------- | ----------------------------------------------------------------------------------- |
| `CLERUM_WORKFLOW_TOOL_SPILLOVER_ENABLED`      | `true`, `false`  | `true`     | Operator kill switch for keeping oversized tool results of a step out of the prompt |
| `CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD`    | bytes            | `131072`   | Size at or above which a tool result is kept out of the prompt                      |
| `CLERUM_WORKFLOW_TOOL_SPILLOVER_BUDGET_BYTES` | bytes            | `16777216` | Per-step-execution cap on result bytes held in memory                               |
| `CLERUM_WORKFLOW_STEP_ENGINE`                 | `legacy`, `core` | `legacy`   | Reserved: selects the step execution loop                                           |

**Step spillover would be on by default.** It is the exception to "new behaviour starts off", so
that every agentic step with tools gets it without configuration. That is acceptable because:

- a step whose tool results all stay under the threshold is unchanged: same prompts, same
  offered tools, nothing stored;
- a successful tool result at or above the threshold is held in the memory of the mcp-host
  process that runs the step, in a store that belongs to that step execution alone. Error
  results, the read tool's own results and results that do not fit the budget stay in the
  prompt. Nothing is written to `/tmp`, to `/output` or to any other volume, so the artifact
  quota does not count stored results and the artifact reader, the snippet runner and the
  download routes cannot see them. A process that dies loses them together with the step
  execution that held them;
- the read tool is offered only after a result has been stored, accepts only references of the
  same step, finds only results of the same step execution, and never returns more than the
  threshold per call. A reference names the step and the call, not the execution, so the same
  reference in another execution resolves only to that execution's own result. The read returns
  the bytes the step would otherwise have received in the prompt; on both paths the step loop
  wraps tool results in `<tool-result>` delimiters and applies no other sanitizer
  (`mcp-host/src/workflow/workflowService.ts:1306-1318`);
- the step status records a read call by its reference and byte count, never by content, and
  logs carry tool names, sizes and references only;
- the store is emptied when the step execution ends, however it ends (completion, failure,
  timeout, abort). There is no time-to-live and no per-process cap: each step execution holds
  at most the budget, a result that does not fit stays in the prompt as it does today, and N
  concurrent step executions in one mcp-host hold at most N × budget, bounded only by the
  container memory limit (`workflow-recipes/src/workflow/podFactory.ts:858-859`);
- setting `CLERUM_WORKFLOW_TOOL_SPILLOVER_ENABLED` to `false` (in any letter case) on the WRC
  Deployment restores the previous behaviour without a code change; it is the only value that
  disables it, and any other value keeps it on. WRC forwards it through
  `MCP_HOST_ENV_PASSTHROUGH`, so it applies to mcp-host pods created after the Deployment has
  it.

It is a separate variable from the agent's `CLERUM_TOOL_SPILLOVER_ENABLED` because threshold and
retention differ: the agent keeps results as files with a time-to-live, a step keeps them in
memory for one step execution. The proposed step threshold is 128 KiB against the agent's 8 KiB
(`mcp-host/src/config.ts:1127-1128`): the step loop does not compact context, so a low threshold
would turn ordinary results into extra read iterations. When steps run on a loop with context
compaction, the step threshold should be revisited and converged with the agent's.

## 5. Open decisions

| #   | Decision                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Request strict field validation on platform writes of `WorkflowRecipe`                                                                                       |
| 2   | Step spillover: accept that, once a result has been stored, the read tool is callable even when the step declares `allowedTools.include`                     |
| 3   | Step spillover: confirm the 128 KiB threshold with the comparison in #1454 (off, 128 KiB, 32 KiB); if 128 KiB fails and 32 KiB passes, the default is 32 KiB |
| 4   | Whether a step field that is in the schema but has no consumer is implemented or removed, case by case                                                       |
| 5   | Where a recipe-level engine setting lives and who may set it                                                                                                 |
| 6   | Whether per-task guardrails and the per-task token brake apply to recipe steps when they run on the agent loop                                               |
| 7   | How many CRD releases the upcoming step fields are grouped into                                                                                              |
| 8   | Whether `status.steps[].toolsCalled[].args` and `.result` are reduced to names, sizes and the artifact reference, and how their current readers move first   |
