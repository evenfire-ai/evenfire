import { describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { K8sGateway } from '../src/k8s.js'
import {
  type ConversationStoreHostSnapshot,
  buildConversationStoreRequestPatch,
  parseConversationStoreRequest,
} from '../src/services/hostConversationStoreService.js'

const intent = parseConversationStoreRequest(
  {
    schemaVersion: 1,
    requestId: '10000000-0000-4000-8000-000000000002',
    hostUid: 'host-current',
    pvcUid: 'pvc-current',
    maintenanceId: '10000000-0000-4000-8000-000000000004',
  },
  'maintenance',
  'operator-current',
  { metadata: { uid: 'host-current', resourceVersion: '17' } }
)

describe('Host conversation-store request Kubernetes wire boundary', () => {
  it('sends only the guarded Host status request with the JSON Patch content type', async () => {
    // Isolate this real gateway method without loading a user kubeconfig or
    // creating clients for unrelated resource/credential operations.
    const gateway = Object.create(K8sGateway.prototype) as K8sGateway
    const patch = vi.fn().mockResolvedValue({})
    Object.defineProperty(gateway, 'customApi', {
      value: { patchNamespacedCustomObjectStatus: patch },
    })
    const host: ConversationStoreHostSnapshot = {
      metadata: { uid: 'host-current', resourceVersion: '17' },
      status: {
        lifecycle: { state: 'active' },
        conversationStore: { maintenance: { phase: 'quiescing' } },
      },
    }
    await gateway.patchHostConversationStoreRequest('chatllm', intent, host)
    const [parameters, options] = patch.mock.calls[0]
    expect(parameters).toEqual({
      group: 'clerum.io',
      version: 'v1alpha1',
      namespace: config.hostsNamespace,
      plural: 'hosts',
      name: 'chatllm',
      body: [
        { op: 'test', path: '/metadata/uid', value: 'host-current' },
        { op: 'test', path: '/metadata/resourceVersion', value: '17' },
        { op: 'add', path: '/status/conversationStore/request', value: intent },
      ],
    })
    const setHeaderParam = vi.fn()
    await options.middleware[0].pre({ setHeaderParam })
    expect(setHeaderParam).toHaveBeenCalledWith('Content-Type', 'application/json-patch+json')
  })
  it('creates only missing parents and never replaces a present status object', () => {
    expect(
      buildConversationStoreRequestPatch(
        { metadata: { uid: 'host-current', resourceVersion: '17' } },
        intent
      )[2]
    ).toEqual({ op: 'add', path: '/status', value: { conversationStore: { request: intent } } })
    expect(
      buildConversationStoreRequestPatch(
        { metadata: { uid: 'host-current', resourceVersion: '17' }, status: { conditions: [] } },
        intent
      )[2].path
    ).toBe('/status/conversationStore')
  })
  it('does not construct a patch from a caller-selected contract that contradicts the fresh Host', () => {
    const host = { metadata: { uid: 'host-current', resourceVersion: '17' } }
    expect(() =>
      buildConversationStoreRequestPatch(host, { ...intent, storageContract: 'canonical' })
    ).toThrow('storage_contract_mismatch')
    expect(buildConversationStoreRequestPatch(host, intent)[2]).toMatchObject({
      value: { conversationStore: { request: intent } },
    })
  })
  it('does not construct a mutation for an absent or different Host binding', () => {
    expect(() => buildConversationStoreRequestPatch({}, intent)).toThrow('host_binding_mismatch')
    expect(() =>
      buildConversationStoreRequestPatch(
        { metadata: { uid: 'host-recreated', resourceVersion: '17' } },
        intent
      )
    ).toThrow('host_binding_mismatch')
  })
})
