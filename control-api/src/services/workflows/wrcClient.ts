export const WORKFLOW_RECIPES_INTERNAL_BASE_URL =
  'http://workflow-recipes.control-plane.svc.cluster.local:8082'

export function buildWrcWorkflowArtifactsUrl(recipeName: string, artifactName?: string): string {
  const base =
    `${WORKFLOW_RECIPES_INTERNAL_BASE_URL}/api/v1/workflow/` +
    `${encodeURIComponent(recipeName)}/artifacts`
  return artifactName ? `${base}/${encodeURIComponent(artifactName)}` : base
}
