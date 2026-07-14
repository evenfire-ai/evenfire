# WorkflowRecipePolicy CRD Reference

**API Group:** `clerum.io`  
**Version:** `v1alpha1`  
**Scope:** Namespaced (cluster governance for recipes)  
**Reconciled / enforced by:** workflow-recipes operator (WRC), typically during
reconcile before workloads are admitted

## Purpose

**Governance and detection policy** for `WorkflowRecipe` deployments — cluster-
or environment-wide rules that can block or constrain recipes (capability
policy, image/digest expectations, detection hooks). Pair with the
[WorkflowRecipe](workflowrecipe.md) CRD.

## Spec fields

Authoritative OpenAPI lives in:

```text
charts/clerum-crds/crds/workflowrecipepolicy.yaml
```

Use that schema plus operator logs when authoring policies. Narrative and ops
context: [workflow-recipes-guide](../deploy/workflow-recipes-guide.md).

## Related

- [WorkflowRecipe](workflowrecipe.md)
- [packages/workflow-recipe-capability-policy](../../packages/workflow-recipe-capability-policy/)
