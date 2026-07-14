export const WORKFLOW_OUTPUT_PVC_NAME = 'clerum-workflow-output'

export const DEFAULT_STEP_TIMEOUT_SECONDS = 300
// Custom coordinator tokens are valid for 3600s. Keep the pod deadline below
// token TTL so the runtime still has a reporting margin for final status and
// artifact metadata before credentials expire.
export const DEFAULT_CUSTOM_COORDINATOR_ACTIVE_DEADLINE_SECONDS = 3300
export const CUSTOM_COORDINATOR_ACTIVE_DEADLINE_BUFFER_SECONDS = 300
// Intentionally equal to the default until custom coordinator token renewal
// exists; every custom run must fit inside one token lifetime plus margin.
export const MAX_CUSTOM_COORDINATOR_ACTIVE_DEADLINE_SECONDS = 3300
