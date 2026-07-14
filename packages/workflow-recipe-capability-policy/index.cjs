'use strict'

const policy = require('./policy.json')

const WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES = Object.freeze([
  ...policy.workflowRecipeDefaultAllowedCapabilities,
])

// Audit/test metadata: runtime enforcement is whitelist-based through
// isWorkflowRecipeDefaultAllowedCapability().
const WORKFLOW_RECIPE_DENIED_CAPABILITIES = Object.freeze([
  ...policy.workflowRecipeDeniedCapabilities,
])

function normalizeCapability(capability) {
  return typeof capability === 'string' ? capability.toUpperCase() : ''
}

function isWorkflowRecipeDefaultAllowedCapability(capability) {
  return WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES.includes(normalizeCapability(capability))
}

function isWorkflowRecipeDeniedCapability(capability) {
  return WORKFLOW_RECIPE_DENIED_CAPABILITIES.includes(normalizeCapability(capability))
}

module.exports = {
  WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES,
  WORKFLOW_RECIPE_DENIED_CAPABILITIES,
  normalizeCapability,
  isWorkflowRecipeDefaultAllowedCapability,
  isWorkflowRecipeDeniedCapability,
}
