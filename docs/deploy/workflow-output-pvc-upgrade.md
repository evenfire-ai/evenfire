# Workflow Output PVC Upgrade Note

This upgrade changes the default WorkflowRecipe output PVC ownership model for
`spec.output.destination: pvc`.

## New Default

When `spec.output.claimName` is omitted, WRC now creates one workflow output PVC
per parent WorkflowRecipe:

```text
<recipe-name>-workflow-output
```

Triggered child runs reuse that parent recipe PVC and write run bytes under:

```text
workflow-output/<parentRecipe>/<runId>/
```

This avoids RWO `Multi-Attach` failures by co-locating the output anchor,
coordinator, mcp-host, snippet runner, and artifact reader on the same node.
It does not create PVCs per run.

For WRC-managed output PVCs, each triggered child run gets a one-shot
`workflow-output-prepare` pod before runtime pods start. That pod runs on the
same node as the output anchor, validates the run-scoped subPath, creates only
that directory chain, and makes it writable by the non-root workflow UID/GID
`1000`. If the prepare pod is pending or fails, WRC keeps the run in
initializing/failed state instead of starting coordinator or artifact-reader
pods against a path that cannot be written.

## Existing Global PVC Artifacts

Older deployments used the shared global PVC:

```text
clerum-workflow-output
```

Existing runs whose artifact bytes live only on that shared PVC will not be
served by a recipe after it moves to the new per-recipe PVC. The DB run history
remains, but download attempts for missing PVC bytes return `artifact_gone`
(`410 Gone` through the API).

Before rollout, operators must choose one path for recipes with historical
artifacts that need to remain downloadable. WRC does not automatically adopt
legacy output PVCs that lack the new ownership/scope labels, because doing so
would make it impossible to distinguish old WRC data from a same-name external
claim.

1. Keep a single recipe on the legacy global PVC by setting:

   ```yaml
   spec:
     output:
       destination: pvc
       claimName: clerum-workflow-output
   ```

   WRC treats `claimName` as external storage: it mounts the PVC but does not
   create, resize, or delete it. The recipe will expose a
   `WorkflowOutputLegacyGlobalClaim` condition as a compatibility warning.
   External claims are also responsible for their own filesystem permissions;
   WRC does not run the output prepare pod or mutate ownership on
   operator-provided claims. The external PVC must be explicitly labeled for
   the recipe scope before rollout:

   ```bash
   kubectl --context=<context> -n sandbox-recipes label pvc clerum-workflow-output \
     clerum.io/workflow-output-external=true \
     clerum.io/workflow-output-claim=clerum-workflow-output \
     clerum.io/workflow-output-scope=<recipe-name>
   ```

   For long names, use the same RFC1123 hash/truncation value that WRC uses for
   workflow output labels. Do not point `spec.output.claimName` at a PVC labeled
   `clerum.io/managed-by=wrc`; remove `claimName` to use WRC-managed lifecycle
   and output preparation.

   The legacy global PVC can safely represent only one exact
   `clerum.io/workflow-output-scope` at a time under this compatibility model.
   Do not use this path to preserve downloads for multiple parent recipes on
   the same shared claim.

2. Accept that old bytes are non-migrated historical data and let the recipe use
   the new WRC-managed per-recipe PVC. Retrigger runs that need fresh artifacts.

3. For multiple recipes that must keep historical downloads, create one
   operator-owned external PVC per parent recipe, copy that recipe's historical
   `workflow-output/<parentRecipe>/...` bytes from `clerum-workflow-output`,
   label each destination PVC with its exact claim and scope labels, and set
   that recipe's `spec.output.claimName` to its per-recipe external claim.

4. Manually copy historical bytes from `clerum-workflow-output` into the new
   WRC-managed per-recipe PVC using the same run-scoped path layout before
   relying on downloads.

Do not set `claimName` for workload/service storage PVCs. `spec.output.claimName`
is only for the workflow output PVC mounted at `/output`; PVCs declared under
`workloads[].volumes` keep their own lifecycle and are not workflow output
storage.

When a parent WorkflowRecipe is deleted, WRC deletes its managed output PVC and
the artifact bytes it contains. The database run and artifact metadata remain
historical records, and download attempts for missing bytes return
`artifact_gone`.
