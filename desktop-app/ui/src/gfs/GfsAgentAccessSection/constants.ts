/**
 * Managed (`1st:`) agents are server-capped to read/write
 * (`managed_agent_permission_forbidden`) — the dropdown never offers more.
 */
export const GFS_AGENT_GRANTABLE_PERMISSIONS = ['read', 'write'] as const

/** Grant subject-key prefix for host subjects (`host:1st:<ns>/<name>`). */
export const GFS_HOST_SUBJECT_KEY_PREFIX = 'host:'
