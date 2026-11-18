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

/**
 * A real apiserver writes the replay, the live events and the end of the stream
 * on one response stream, and client-node reads that stream in order. Whatever
 * the fake sends after watch() was called must arrive behind the replay.
 */
describe('fake apiservers deliver one watch stream in the order it was written', () => {
  const settle = async () => {
    for (let tick = 0; tick < 10; tick++) await Promise.resolve()
  }
  const at = (type: string, object: unknown) =>
    `${type}@${(object as { metadata: { resourceVersion: string } }).metadata.resourceVersion}`

  it('the Secret fake delivers a change made right after watch() behind the older replay', async () => {
    const api = fakeSecretApiserver('ns', ['alpha'])
    const from = api.revision()
    api.modify('alpha')
    const seen: string[] = []

    await api.watch(
      '/api/v1/namespaces/ns/secrets',
      { resourceVersion: from },
      (type, object) => seen.push(at(type, object)),
      () => undefined
    )
    api.modify('alpha')
    await settle()

    expect(seen).toEqual(['MODIFIED@102', 'MODIFIED@103'])
  })

  it('the Secret fake delivers a Secret created right after watch() behind the initial ADDED events', async () => {
    const api = fakeSecretApiserver('ns', ['alpha'])
    const seen: string[] = []

    await api.watch(
      '/api/v1/namespaces/ns/secrets',
      {},
      (type, object) => seen.push(at(type, object)),
      () => undefined
    )
    api.create('beta')
    await settle()

    expect(seen).toEqual(['ADDED@101', 'ADDED@102'])
  })

  it('the Secret fake ends the stream behind the replay', async () => {
    const api = fakeSecretApiserver('ns', ['alpha'])
    const from = api.revision()
    api.modify('alpha')
    const seen: string[] = []

    await api.watch(
      '/api/v1/namespaces/ns/secrets',
      { resourceVersion: from },
      (type, object) => seen.push(at(type, object)),
      () => seen.push('done')
    )
    api.disconnect(null)
    await settle()

    expect(seen).toEqual(['MODIFIED@102', 'done'])
  })

  it('a change made from inside a callback stays behind the events already written', async () => {
    const api = fakeSecretApiserver('ns', ['alpha'])
    const from = api.revision()
    api.modify('alpha')
    const seen: string[] = []

    await api.watch(
      '/api/v1/namespaces/ns/secrets',
      { resourceVersion: from },
      (type, object) => {
        if (seen.push(at(type, object)) === 1) api.create('beta')
      },
      () => undefined
    )
    api.modify('alpha')
    await settle()

    expect(seen).toEqual(['MODIFIED@102', 'MODIFIED@103', 'ADDED@104'])
  })

  it('the Deployment fake delivers a change made right after watch() behind the older replay', async () => {
    const api = fakeDeploymentApiserver('ns', { web: { generation: 1, ready: false } })
    const from = api.revision()
    api.set('web', { generation: 2, ready: false })
    const seen: string[] = []

    await api.watch(
      '/apis/apps/v1/namespaces/ns/deployments',
      { resourceVersion: from },
      (type, object) => seen.push(at(type, object)),
      () => undefined
    )
    api.set('web', { generation: 2, ready: true })
    await settle()

    expect(seen).toEqual(['MODIFIED@101', 'MODIFIED@102'])
  })

  it('the Deployment fake ends the stream behind the replay', async () => {
    const api = fakeDeploymentApiserver('ns', { web: { generation: 1, ready: false } })
    const from = api.revision()
    api.set('web', { generation: 2, ready: true })
    const seen: string[] = []

    await api.watch(
      '/apis/apps/v1/namespaces/ns/deployments',
      { resourceVersion: from },
      (type, object) => seen.push(at(type, object)),
      () => seen.push('done')
    )
    api.disconnect(null)
    await settle()

    expect(seen).toEqual(['MODIFIED@101', 'done'])
  })
})
