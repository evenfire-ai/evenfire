export const PR2_READINESS_CONTRACT_VERSION = 'pr2-readiness-v1' as const

export const PR2_READINESS_HOPS = [
  'action_contracts',
  'control_action_delegation',
  'external_rest_delegation_transport',
  'rpc_proxy_trusted_edge',
  'mcp_host_live_effects',
  'activity_session_search_provenance',
  'rpc_admission_map',
  'sandbox_derived_view',
  'remote_desktop_derived_view',
  'oauth_exact_target',
  'workflow_service_edge',
  'workflow_authority_bindings',
  'workflow_recipes_checkpoint',
  'workflow_approval_child_transition',
  'workflow_artifact_list',
  'gfs_controller_checkpoint',
  'workspace_files_controller_checkpoint',
] as const

export type Pr2ReadinessHop = (typeof PR2_READINESS_HOPS)[number]
