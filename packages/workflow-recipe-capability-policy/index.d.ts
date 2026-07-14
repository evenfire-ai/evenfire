export declare const WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES: readonly string[]
/**
 * Audit/test metadata for capabilities that must never appear in default
 * user-authored workload admission. Runtime enforcement remains whitelist-based.
 */
export declare const WORKFLOW_RECIPE_DENIED_CAPABILITIES: readonly string[]
export declare function normalizeCapability(capability: unknown): string
export declare function isWorkflowRecipeDefaultAllowedCapability(capability: unknown): boolean
export declare function isWorkflowRecipeDeniedCapability(capability: unknown): boolean
