/** Shared CRD constants for the clerum.io API group. */
export const CRD_GROUP = 'clerum.io'
export const CRD_VERSION = 'v1alpha1'
export const WORKFLOWRECIPE_PLURAL = 'workflowrecipes'

/**
 * Child recipe label stamped by the DB-run child creator when the run row
 * carries an authority binding. Whether a run has a binding is fixed when the
 * row is inserted, so the label is decided once, at child creation. The
 * status endpoints run the durable running boundary only for a child whose
 * label equals RUN_AUTHORITY_BOUND; any other value, or no label, is a V1 run
 * decided by recipe status without reading the run store.
 */
export const RUN_AUTHORITY_LABEL = 'clerum.io/workflow-run-authority'
export const RUN_AUTHORITY_BOUND = 'bound'

/**
 * Shared set of terminal workflow phases used by historyManager,
 * and any other module that needs to distinguish "still running" from "done".
 * Single source of truth — prevents drift between modules.
 */
export const WORKFLOW_TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled'])
