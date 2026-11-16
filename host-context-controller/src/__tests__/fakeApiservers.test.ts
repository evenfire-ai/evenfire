import { describe, expect, it } from 'vitest'
import { fakeDeploymentApiserver } from './fakeDeploymentApiserver'
import { fakeSecretApiserver } from './fakeSecretApiserver'

/**
 * client-node 1.4.0 returns from watch() once its line listeners are attached;
 * replayed events come from the response stream afterwards. The fakes must not
 * deliver them before the caller's await on watch() has resumed.
 */
describe('fake apiservers deliver replayed watch events after watch() resolves', () => {
  it('the Secret fake replays the initial ADDED events after the caller resumes', async () => {
    const api = fakeSecretApiserver('ns', ['alpha'])
    const seen: string[] = []
    let resumed = false

    await api.watch(
      '/api/v1/namespaces/ns/secrets',
      {},
      type => seen.push(`${type}:${resumed}`),
      () => undefined
    )
    resumed = true
    for (let tick = 0; tick < 10; tick++) await Promise.resolve()

    expect(seen).toEqual(['ADDED:true'])
  })

  it('the Secret fake replays changes after a resourceVersion after the caller resumes', async () => {
    const api = fakeSecretApiserver('ns', ['alpha'])
    const from = api.revision()
    api.modify('alpha')
    const seen: string[] = []
    let resumed = false

    await api.watch(
      '/api/v1/namespaces/ns/secrets',
      { resourceVersion: from },
      type => seen.push(`${type}:${resumed}`),
      () => undefined
    )
    resumed = true
    for (let tick = 0; tick < 10; tick++) await Promise.resolve()

    expect(seen).toEqual(['MODIFIED:true'])
  })

  it('the Deployment fake replays changes after a resourceVersion after the caller resumes', async () => {
    const api = fakeDeploymentApiserver('ns', { web: { generation: 1, ready: false } })
    const from = api.revision()
    api.set('web', { generation: 2, ready: true })
    const seen: string[] = []
    let resumed = false

    await api.watch(
      '/apis/apps/v1/namespaces/ns/deployments',
      { resourceVersion: from },
      type => seen.push(`${type}:${resumed}`),
      () => undefined
    )
    resumed = true
    for (let tick = 0; tick < 10; tick++) await Promise.resolve()

    expect(seen).toEqual(['MODIFIED:true'])
  })
})
