import {
  CODEX_CONNECTION_REF_ANNOTATION,
  assertCodexConnectionKey,
  isCodexUnassignedConnectionKey,
} from './codexSubscriptionConnection.js'
import {
  assertGrokConnectionKey,
  isGrokUnassignedConnectionKey,
} from './grokSubscriptionConnection.js'
import {
  SUBSCRIPTION_CONNECTION_REF_ANNOTATION,
  collectRecipeOauthBrokerProviders,
} from './subscriptionGrantIdentity.js'

/**
 * Server authority for WorkflowRecipe oauth-broker grant annotations.
 *
 * Write shapes:
 *   - codex-subscription: `{codex-connection-ref: k, subscription-connection-ref: k}`
 *   - any other broker (grok-subscription): `{codex-connection-ref: '', subscription-connection-ref: k}`
 *
 * Transition table (explicit = either annotation key present in the body):
 *   - alias and canonical both non-empty and unequal → 422 on any spec
 *   - create / static→broker: omitted → grant required; explicit → validate, write shape
 *   - same broker: omitted → keep stored; explicit → validate, write shape
 *   - broker change: omitted → 422 providerChangeRequiresGrant; explicit → validate, write shape
 *   - broker→static: clear both unless the recipe declares pluginWorkloadSdk (SDK route owns it)
 *   - static→static / static create: keep (the SDK route owns static-recipe identity)
 *
 * Pure and total: every input maps to a result or 422 errors, never a throw.
 */

export interface RecipeGrantValidationError {
  field: string
  message: string
  rule?: string
}

export type RecipeGrantTransitionResult =
  | {
      ok: true
      /** Annotation patch merged over the stored annotations. `{}` keeps them. */
      annotations: Record<string, string>
    }
  | { ok: false; errors: RecipeGrantValidationError[] }

export interface RecipeGrantTransitionInput {
  body: {
    spec?: Record<string, unknown>
    metadata?: { annotations?: Record<string, unknown> }
  }
  /** Stored recipe on update; omitted for create and /validate. */
  current?: {
    spec?: Record<string, unknown>
    annotations?: Record<string, string>
  } | null
}

const ALIAS_FIELD = `metadata.annotations.${CODEX_CONNECTION_REF_ANNOTATION}`
const CANONICAL_FIELD = `metadata.annotations.${SUBSCRIPTION_CONNECTION_REF_ANNOTATION}`

type BrokerRules = {
  field: string
  requiredRule: string
  requiredMessage: string
  invalidRule: string
  invalidMessage: string
  isUnassigned: (key: string) => boolean
  assertKey: (key: string) => string
  shape: (key: string) => Record<string, string>
}

const CODEX_RULES: BrokerRules = {
  field: ALIAS_FIELD,
  requiredRule: 'codexRecipeGrantRequired',
  requiredMessage: 'Codex subscription recipes must choose an existing ChatGPT grant',
  invalidRule: 'codexRecipeGrantInvalid',
  invalidMessage: 'clerum.io/codex-connection-ref is not a valid connection key',
  isUnassigned: isCodexUnassignedConnectionKey,
  assertKey: assertCodexConnectionKey,
  shape: key => ({
    [CODEX_CONNECTION_REF_ANNOTATION]: key,
    [SUBSCRIPTION_CONNECTION_REF_ANNOTATION]: key,
  }),
}

const GROK_RULES: BrokerRules = {
  field: CANONICAL_FIELD,
  requiredRule: 'grokRecipeGrantRequired',
  requiredMessage: 'Grok subscription recipes must choose an existing Grok grant',
  invalidRule: 'grokRecipeGrantInvalid',
  invalidMessage: 'clerum.io/subscription-connection-ref is not a valid connection key',
  isUnassigned: isGrokUnassignedConnectionKey,
  assertKey: assertGrokConnectionKey,
  shape: key => ({
    [CODEX_CONNECTION_REF_ANNOTATION]: '',
    [SUBSCRIPTION_CONNECTION_REF_ANNOTATION]: key,
  }),
}

function brokerRules(provider: string): BrokerRules {
  return provider === 'codex-subscription' ? CODEX_RULES : GROK_RULES
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function recipeBroker(spec: unknown): string | undefined {
  if (!isRecord(spec)) return undefined
  return collectRecipeOauthBrokerProviders(spec)[0]
}

function hasPluginWorkloadSdk(spec: unknown): boolean {
  return isRecord(spec) && isRecord(spec.pluginWorkloadSdk)
}

function stringAnnotation(annotations: Record<string, unknown>, key: string): string {
  const value = annotations[key]
  return typeof value === 'string' ? value.trim() : ''
}

function error(field: string, rule: string, message: string): RecipeGrantTransitionResult {
  return { ok: false, errors: [{ field, rule, message }] }
}

const CLEARED = {
  [CODEX_CONNECTION_REF_ANNOTATION]: '',
  [SUBSCRIPTION_CONNECTION_REF_ANNOTATION]: '',
}

export function resolveRecipeGrantTransition(
  input: RecipeGrantTransitionInput
): RecipeGrantTransitionResult {
  const rawAnnotations = isRecord(input.body.metadata?.annotations)
    ? input.body.metadata.annotations
    : {}
  const explicit =
    Object.prototype.hasOwnProperty.call(rawAnnotations, CODEX_CONNECTION_REF_ANNOTATION) ||
    Object.prototype.hasOwnProperty.call(rawAnnotations, SUBSCRIPTION_CONNECTION_REF_ANNOTATION)
  const alias = stringAnnotation(rawAnnotations, CODEX_CONNECTION_REF_ANNOTATION)
  const canonical = stringAnnotation(rawAnnotations, SUBSCRIPTION_CONNECTION_REF_ANNOTATION)
  const nextBroker = recipeBroker(input.body.spec)

  if (explicit && alias && canonical && alias !== canonical) {
    return error(
      nextBroker && nextBroker !== 'codex-subscription' ? CANONICAL_FIELD : ALIAS_FIELD,
      'subscriptionAnnotationsDisagree',
      'subscription connection annotations disagree'
    )
  }

  const current = input.current ?? undefined
  const previousBroker = current ? recipeBroker(current.spec) : undefined

  if (!nextBroker) {
    // Leaving a broker without an SDK: the agent grant no longer has an owner.
    if (previousBroker && !hasPluginWorkloadSdk(input.body.spec)) {
      return { ok: true, annotations: { ...CLEARED } }
    }
    // Static recipes (and SDK recipes leaving a broker) keep whatever the
    // plugin-workload-sdk grant route published.
    return { ok: true, annotations: {} }
  }

  const rules = brokerRules(nextBroker)
  if (!explicit) {
    if (previousBroker === nextBroker) return { ok: true, annotations: {} }
    if (previousBroker) {
      return error(
        rules.field,
        'providerChangeRequiresGrant',
        `Changing the recipe oauth-broker provider from ${previousBroker} to ${nextBroker} requires choosing a ${nextBroker} grant`
      )
    }
    return error(rules.field, rules.requiredRule, rules.requiredMessage)
  }

  let key: string
  if (nextBroker === 'codex-subscription') {
    key = canonical || alias
  } else {
    if (alias) {
      return error(
        CANONICAL_FIELD,
        'subscriptionAnnotationsDisagree',
        'Codex connection annotation is not valid for this oauth-broker provider'
      )
    }
    key = canonical
  }
  if (!key || rules.isUnassigned(key)) {
    return error(rules.field, rules.requiredRule, rules.requiredMessage)
  }
  try {
    rules.assertKey(key)
  } catch {
    return error(rules.field, rules.invalidRule, rules.invalidMessage)
  }
  return { ok: true, annotations: rules.shape(key) }
}
