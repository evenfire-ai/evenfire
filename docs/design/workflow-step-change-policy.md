# Workflow step change policy and flags

> **Status:** Proposed. Section 5 lists the decisions that are still open.
>
> **Scope:** how changes to `WorkflowRecipe.spec.steps[]` and to step execution are introduced.
> This record states principles and policy. It does not propose new CRD fields; each feature
> brings its own fields with its own change.

Code references are `path:line` at `dev` commit `61f32ae`.

---

## 1. Why this record exists

A step field travels through four hops before it has any effect:

1. the CRD schema (`charts/clerum-crds/crds/workflowrecipe.yaml`);
2. the per-field projection WRC writes into the coordinator ConfigMap
   (`workflow-recipes/src/workflow/workflowReconciler.ts:5568-5609`);
3. the coordinator parser (`workflow-recipes/src/workflow/sdkRuntime.ts:566-606`);
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
   secrets; reports and logs record names, sizes and references rather than content.

## 3. Policy for unsupported fields

The rule of principle 1 is enforced at three layers.

1. **API server.** The schema is structural, so a cluster with an older CRD prunes a newer
   field without an error. Platform writers of `WorkflowRecipe` objects should request strict
   field validation so an unknown field is rejected instead of pruned.
2. **WRC.** The preflight validation
   (`workflow-recipes/src/workflow/workflowReconciler.ts:1759`) should reject, with a status
   condition, any field the running WRC knows but does not implement.
3. **Coordinator.** The step parser should reject unknown step keys, as it already does inside
   `run` (`workflow-recipes/src/workflow/sdkRuntime.ts:648`).

A contract test keeps the layers aligned: it enumerates the step schema from the chart YAML and
fails when a field is not projected, not parsed or not consumed, unless the field is on an
explicit, justified exception list.

## 4. Flag policy

- **Precedence:** recipe-level setting where one exists, then operator environment on the WRC
  Deployment, then the default.
- Operator environment reaches recipe pods only through the reviewed allowlist in
  `workflow-recipes/src/workflow/podFactory.ts:78-83`. A flag is usable by operators only once
  it is on that list, so the allowlist change ships before the behaviour it controls.
- The effective execution path is recorded with the step result, so an outcome can be
  attributed to the code that produced it.
- Each flag is introduced with its removal criterion.
- New behaviour starts off, with one exception described below.

| Flag                                          | Values           | Default    | Purpose                                                                                |
| --------------------------------------------- | ---------------- | ---------- | -------------------------------------------------------------------------------------- |
| `CLERUM_WORKFLOW_TOOL_SPILLOVER_ENABLED`      | `true`, `false`  | `true`     | Operator kill switch for persisting oversized tool results of a step out of the prompt |
| `CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD`    | bytes            | `32768`    | Size above which a tool result is persisted                                            |
| `CLERUM_WORKFLOW_TOOL_SPILLOVER_BUDGET_BYTES` | bytes            | `16777216` | Per-step cap on persisted bytes                                                        |
| `CLERUM_WORKFLOW_STEP_ENGINE`                 | `legacy`, `core` | `legacy`   | Reserved: selects the step execution loop                                              |

**Step spillover is on by default.** It is the exception to "new behaviour starts off", so that
every recipe with an mcp-host gets it without configuration. That is acceptable because:

- a step whose tool results all stay under the threshold is unchanged: same prompts, same
  offered tools, nothing written;
- the read tool is offered only after a result has been persisted, is limited to results of the
  same step, and never returns more than the threshold per call;
- persisted results are deleted when the step ends;
- the switch restores the previous behaviour without a code change.

It is a separate variable from the agent's `CLERUM_TOOL_SPILLOVER_ENABLED` because threshold and
retention differ. The step threshold is 32 KiB against the agent's 8 KiB
(`mcp-host/src/config.ts:1127-1128`): the step loop does not compact context, so a low threshold
would turn ordinary results into extra read iterations. When steps run on a loop with context
compaction, the step threshold should be revisited and converged with the agent's.

## 5. Open decisions

| #   | Decision                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Request strict field validation on platform writes of `WorkflowRecipe`                                                                      |
| 2   | Step spillover: accept that, once a result has been persisted, the read tool is callable even when the step declares `allowedTools.include` |
| 3   | Step spillover: confirm the 32 KiB threshold after measuring it against a larger value on real recipes                                      |
| 4   | Whether a step field that is in the schema but has no consumer is implemented or removed, case by case                                      |
| 5   | Where a recipe-level engine setting lives and who may set it                                                                                |
| 6   | Whether per-task guardrails and the per-task token brake apply to recipe steps when they run on the agent loop                              |
| 7   | How many CRD releases the upcoming step fields are grouped into                                                                             |
