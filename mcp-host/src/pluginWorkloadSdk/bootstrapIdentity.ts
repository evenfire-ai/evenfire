import { PROVIDER_AUTH_MODE, isLlmProviderId, isRunnableLlmModelId } from '@clerum/llm-providers'
import type { PluginWorkloadSdkCapability } from '../config'
import { isLlmProvider } from '../llm/registryCore'
import type { LlmProvider } from '../llm/registryCore'
import type { ConfigureResponse, PluginWorkloadSdkBootstrapRequest } from '../workflow/types'
import type {
  PluginWorkloadSdkBootstrapProof,
  PluginWorkloadSdkClientNotificationsBootstrapProof,
} from './promptBridge/controlApiClient'
import { readVerifiedSdkOnlyCodexBinding, replaceSdkOnlyCodexBinding } from './sdkOnlyCodexBinding'
import { readVerifiedSdkOnlyGrokBinding, replaceSdkOnlyGrokBinding } from './sdkOnlyGrokBinding'

export interface PluginWorkloadSdkBootstrapIdentityDeps {
  /**
   * Capability projection derived from the pod configuration. The bootstrap
   * request may echo this family for protocol compatibility, but it must not
   * choose which verification branch runs.
   */
  capabilityFamily: PluginWorkloadSdkBootstrapCapabilityFamily
  onConfigured?: (context: { provider: LlmProvider; defaultModel: string }) => void
  verify?: (provider: string, model: string) => Promise<PluginWorkloadSdkBootstrapProof | null>
  verifyClientNotifications?: () => Promise<PluginWorkloadSdkClientNotificationsBootstrapProof | null>
}

export type PluginWorkloadSdkBootstrapCapabilityFamily = 'promptBridge' | 'clientNotifications'

function isOauthBrokerProvider(provider: string): boolean {
  return isLlmProviderId(provider) && PROVIDER_AUTH_MODE[provider] === 'oauth-broker'
}

/**
 * Resolve the one bootstrap proof WRC is allowed to request from the
 * capability projection mounted into this mcp-host. A mixed recipe bootstraps
 * through promptBridge, whose proof also carries the notification policy
 * proof; a notification-only recipe remains provider-free.
 */
export function resolvePluginWorkloadSdkBootstrapCapabilityFamily(
  capabilities: readonly PluginWorkloadSdkCapability[]
): PluginWorkloadSdkBootstrapCapabilityFamily {
  return capabilities.includes('clientNotifications') && !capabilities.includes('promptBridge')
    ? 'clientNotifications'
    : 'promptBridge'
}

/**
 * Validate and publish the public provider/model bootstrap identity shared by
 * workflow and sdk-only hosts. Credentials are deliberately absent from this
 * contract; promptBridge resolves one credential ticket per provider attempt.
 */
export async function configurePluginWorkloadSdkBootstrapIdentity(
  req: PluginWorkloadSdkBootstrapRequest | undefined,
  deps: PluginWorkloadSdkBootstrapIdentityDeps
): Promise<ConfigureResponse> {
  const capabilityFamily = deps.capabilityFamily
  if (req?.capabilityFamily !== undefined && req.capabilityFamily !== capabilityFamily) {
    return {
      configured: false,
      ready: false,
      contractVersion: 2,
      capabilityFamily,
      message: 'Plugin Workload SDK bootstrap capability family does not match the host projection',
    }
  }
  if (capabilityFamily === 'clientNotifications') {
    const proof = deps.verifyClientNotifications ? await deps.verifyClientNotifications() : null
    if (!proof) {
      return {
        configured: false,
        ready: false,
        contractVersion: 2,
        capabilityFamily: 'clientNotifications',
        message: 'Plugin Workload SDK clientNotifications readiness is not available',
      }
    }
    return {
      configured: true,
      ready: proof.ready,
      contractVersion: 2,
      capabilityFamily: 'clientNotifications',
      policyReady: proof.policyReady,
      policyState: proof.policyState,
      ...(proof.policyReason ? { policyReason: proof.policyReason } : {}),
    }
  }
  if (!req?.provider) {
    return { configured: false, message: 'provider is required' }
  }
  if (!isLlmProvider(req.provider)) {
    return { configured: false, message: `Unknown provider: ${req.provider}` }
  }
  const model = typeof req.model === 'string' ? req.model.trim() : ''
  if (!isRunnableLlmModelId(model)) {
    return { configured: false, message: 'model is required and has an invalid format' }
  }
  // Always integrity-check a supplied binding before the provider protocol
  // branch. Request-controlled provider/version must not skip this check.
  // Each provider reads only its own slot: WRC writes Grok proofs to
  // `subscriptionBinding` and Codex proofs to `codexBinding`, so a proof in the
  // other slot is never a fallback for a missing one.
  const grok = req.provider === 'grok-subscription'
  const verifiedBinding = grok
    ? readVerifiedSdkOnlyGrokBinding(req.subscriptionBinding, model)
    : readVerifiedSdkOnlyCodexBinding(req.codexBinding, model)
  const missingReason = grok ? 'execution_binding_missing' : 'codex_execution_binding_missing'
  if (isOauthBrokerProvider(req.provider)) {
    if (!verifiedBinding) {
      replaceSdkOnlyCodexBinding(null)
      replaceSdkOnlyGrokBinding(null)
      return {
        configured: true,
        ready: true,
        capabilityFamily: 'promptBridge',
        provider: req.provider,
        model,
        contractVersion: 3,
        policyReady: false,
        policyState: 'binding_missing',
        policyReason: missingReason,
        ...(grok ? { bindingReady: false } : {}),
        message: grok
          ? 'SDK-only Grok bootstrap requires a live v3 execution binding'
          : 'SDK-only Codex bootstrap requires a live v3 execution binding',
      }
    }
    if (grok) {
      replaceSdkOnlyCodexBinding(null)
      replaceSdkOnlyGrokBinding(verifiedBinding)
    } else {
      replaceSdkOnlyGrokBinding(null)
      replaceSdkOnlyCodexBinding(verifiedBinding)
    }
  } else {
    replaceSdkOnlyCodexBinding(null)
    replaceSdkOnlyGrokBinding(null)
  }
  // The binding must be installed BEFORE this call — `deps.verify` reads the
  // live global to build its capabilities request. That ordering means a throw
  // here (a transport failure, a control-api 5xx) would otherwise leave the
  // global populated with a binding this bootstrap never confirmed, and the
  // next prompt would execute against it. Clear it and rethrow: an unverified
  // binding must not survive the attempt that failed to verify it. The error
  // itself is not swallowed — the caller still sees the failure.
  let proof: Awaited<ReturnType<NonNullable<typeof deps.verify>>> | null = null
  try {
    proof = deps.verify ? await deps.verify(req.provider, model) : null
  } catch (err) {
    if (isOauthBrokerProvider(req.provider)) {
      replaceSdkOnlyCodexBinding(null)
      replaceSdkOnlyGrokBinding(null)
    }
    throw err
  }
  if (deps.verify && !proof) {
    if (isOauthBrokerProvider(req.provider)) {
      replaceSdkOnlyCodexBinding(null)
      replaceSdkOnlyGrokBinding(null)
    }
    return {
      configured: false,
      ready: false,
      contractVersion: isOauthBrokerProvider(req.provider) ? 3 : 2,
      message: 'Plugin Workload SDK identity bootstrap contract is not ready',
    }
  }
  if (
    isOauthBrokerProvider(req.provider) &&
    proof &&
    (proof.codexBindingReady === false ||
      proof.bindingReady === false ||
      proof.policyReason === 'codex_execution_binding_missing' ||
      proof.policyReason === 'execution_binding_missing')
  ) {
    replaceSdkOnlyCodexBinding(null)
    replaceSdkOnlyGrokBinding(null)
    const rejectedReason = grok ? 'execution_binding_missing' : 'codex_execution_binding_missing'
    return {
      configured: true,
      ready: true,
      capabilityFamily: 'promptBridge',
      provider: req.provider,
      model,
      contractVersion: 3,
      policyReady: false,
      policyState: proof.policyState,
      policyReason: rejectedReason,
      ...(grok ? { bindingReady: false } : {}),
      message: grok
        ? 'Control API rejected the SDK-only Grok execution binding'
        : 'Control API rejected the SDK-only Codex execution binding',
      ...(verifiedBinding && grok ? { subscriptionBinding: verifiedBinding } : {}),
      ...(verifiedBinding && !grok ? { codexBinding: verifiedBinding } : {}),
    }
  }
  deps.onConfigured?.({ provider: req.provider, defaultModel: model })
  const contractVersion = isOauthBrokerProvider(req.provider) ? 3 : 2
  return {
    configured: true,
    ready: true,
    capabilityFamily: 'promptBridge',
    provider: req.provider,
    model,
    contractVersion,
    ...(proof ? { policyReady: proof.policyReady, policyState: proof.policyState } : {}),
    ...(proof?.policyReason ? { policyReason: proof.policyReason } : {}),
    ...(proof?.policyRevision !== undefined ? { policyRevision: proof.policyRevision } : {}),
    ...(proof?.policyHash !== undefined ? { policyHash: proof.policyHash } : {}),
    ...(proof?.defaultTargetRef !== undefined ? { defaultTargetRef: proof.defaultTargetRef } : {}),
    ...(proof?.defaultProvider !== undefined ? { defaultProvider: proof.defaultProvider } : {}),
    ...(proof?.defaultModel !== undefined ? { defaultModel: proof.defaultModel } : {}),
    ...(proof?.clientNotificationsPolicyReady !== undefined
      ? { clientNotificationsPolicyReady: proof.clientNotificationsPolicyReady }
      : {}),
    ...(proof?.clientNotificationsPolicyState !== undefined
      ? { clientNotificationsPolicyState: proof.clientNotificationsPolicyState }
      : {}),
    ...(proof?.clientNotificationsPolicyReason !== undefined
      ? { clientNotificationsPolicyReason: proof.clientNotificationsPolicyReason }
      : {}),
    ...(isOauthBrokerProvider(req.provider) && verifiedBinding && grok
      ? { subscriptionBinding: verifiedBinding, bindingReady: true }
      : {}),
    ...(isOauthBrokerProvider(req.provider) && verifiedBinding && !grok
      ? { codexBinding: verifiedBinding }
      : {}),
  }
}
