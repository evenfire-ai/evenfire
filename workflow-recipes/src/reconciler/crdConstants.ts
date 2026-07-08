/** Shared CRD constants for the clerum.io API group. */
export const CRD_GROUP = 'clerum.io'
export const CRD_VERSION = 'v1alpha1'
export const WORKFLOWRECIPE_PLURAL = 'workflowrecipes'

/**
 * Shared set of terminal workflow phases used by rateLimiter, historyManager,
 * and any other module that needs to distinguish "still running" from "done".
 * Single source of truth — prevents drift between modules.
 */
export const WORKFLOW_TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled'])
