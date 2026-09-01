import { isRunnableLlmModelId } from '@clerum/llm-providers'
import type { PluginWorkloadSdkCapability } from '../config'
import { isLlmProvider } from '../llm/registryCore'
import type { LlmProvider } from '../llm/registryCore'
import type { ConfigureResponse, PluginWorkloadSdkBootstrapRequest } from '../workflow/types'
import type {
  PluginWorkloadSdkBootstrapProof,
  PluginWorkloadSdkClientNotificationsBootstrapProof,
} from './promptBridge/controlApiClient'
import { readVerifiedSdkOnlyCodexBinding, replaceSdkOnlyCodexBinding } from './sdkOnlyCodexBinding'

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
  const verifiedBinding = readVerifiedSdkOnlyCodexBinding(req.codexBinding, model)
  if (req.provider === 'codex-subscription') {
    if (!verifiedBinding) {
      replaceSdkOnlyCodexBinding(null)
      return {
        configured: true,
        ready: true,
        capabilityFamily: 'promptBridge',
        provider: req.provider,
        model,
        contractVersion: 3,
        policyReady: false,
        policyState: 'binding_missing',
        policyReason: 'codex_execution_binding_missing',
        message: 'SDK-only Codex bootstrap requires a live v3 execution binding',
      }
    }
    replaceSdkOnlyCodexBinding(verifiedBinding)
  } else {
    replaceSdkOnlyCodexBinding(null)
  }
  const proof = deps.verify ? await deps.verify(req.provider, model) : null
  if (deps.verify && !proof) {
    if (req.provider === 'codex-subscription') replaceSdkOnlyCodexBinding(null)
    return {
      configured: false,
      ready: false,
      contractVersion: req.provider === 'codex-subscription' ? 3 : 2,
      message: 'Plugin Workload SDK identity bootstrap contract is not ready',
    }
  }
  if (
    req.provider === 'codex-subscription' &&
    proof &&
    (proof.codexBindingReady === false || proof.policyReason === 'codex_execution_binding_missing')
  ) {
    replaceSdkOnlyCodexBinding(null)
    return {
      configured: true,
      ready: true,
      capabilityFamily: 'promptBridge',
      provider: req.provider,
      model,
      contractVersion: 3,
      policyReady: false,
      policyState: proof.policyState,
      policyReason: 'codex_execution_binding_missing',
      message: 'Control API rejected the SDK-only Codex execution binding',
      ...(req.codexBinding ? { codexBinding: req.codexBinding } : {}),
    }
  }
  deps.onConfigured?.({ provider: req.provider, defaultModel: model })
  const contractVersion = req.provider === 'codex-subscription' ? 3 : 2
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
    ...(req.provider === 'codex-subscription' && req.codexBinding
      ? { codexBinding: req.codexBinding }
      : {}),
  }
}
