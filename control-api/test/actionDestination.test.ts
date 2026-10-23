import { describe, expect, it, vi } from 'vitest'
import {
  type ActionOperationId,
  canonicalResourceIdentity,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import { config } from '../src/config.js'
import { resolveActionDestination } from '../src/services/access/actionDestination.js'

const runtimeOperations: ReadonlyArray<
  readonly [ActionOperationId, Readonly<Record<string, string>>]
> = [
  ['task.read', { hostRef: `${config.hostsNamespace}/chatllm`, taskId: 'task-a' }],
  [
    'task.manage',
    { hostRef: `${config.hostsNamespace}/chatllm`, taskId: 'task-a', action: 'cancel' },
  ],
  ['model.read', { hostRef: `${config.hostsNamespace}/chatllm`, agent: 'a', chatId: 'c' }],
  [
    'model.select',
    {
      hostRef: `${config.hostsNamespace}/chatllm`,
      agent: 'a',
      chatId: 'c',
      provider: 'openai',
      model: 'model-a',
    },
  ],
  ['session.read', { hostRef: `${config.hostsNamespace}/chatllm` }],
  [
    'session.manage',
    {
      hostRef: `${config.hostsNamespace}/chatllm`,
      agent: 'a',
      chatId: 'c',
      action: 'delete',
    },
  ],
]

describe('runtime-session action destinations', () => {
  it.each(runtimeOperations)(
    'resolves the validated target host for %s',
    async (operationId, raw) => {
      const resource = canonicalResourceIdentity({
        environmentId: 'test',
        type: 'runtime_session',
        logicalId: 'session-a',
      })
      const target = validateActionOperationTarget({
        operationId,
        resource,
        operationTarget: raw,
      })
      const gateway = { getResourceExact: vi.fn() }

      await expect(
        resolveActionDestination({
          resource,
          target,
          gateway,
          budget: {} as never,
        })
      ).resolves.toEqual({
        status: 'resolved',
        destination: {
          kind: 'host',
          ref: `${config.hostsNamespace}/chatllm`,
          url: `http://chatllm.${config.hostsNamespace}.svc.cluster.local:8080`,
        },
      })
      expect(gateway.getResourceExact).not.toHaveBeenCalled()
    }
  )

  it('rejects a substituted host namespace without Kubernetes discovery', async () => {
    const resource = canonicalResourceIdentity({
      environmentId: 'test',
      type: 'runtime_session',
      logicalId: 'session-a',
    })
    const target = validateActionOperationTarget({
      operationId: 'session.read',
      resource,
      operationTarget: { hostRef: 'other-namespace/chatllm' },
    })
    const gateway = { getResourceExact: vi.fn() }

    await expect(
      resolveActionDestination({ resource, target, gateway, budget: {} as never })
    ).resolves.toEqual({ status: 'not_found' })
    expect(gateway.getResourceExact).not.toHaveBeenCalled()
  })
})
