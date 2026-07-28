import { describe, expect, it } from 'vitest'
import { collectInitialProtocolUrls } from '../protocolLaunchArgs.js'

describe('collectInitialProtocolUrls', () => {
  it('collects each initial Evenfire link once', () => {
    const setupUrl =
      'evenfire://desktop-setup?email=user%40example.com&authorizationToken=single-use-token'

    expect(collectInitialProtocolUrls(['Evenfire', setupUrl, setupUrl]).evenfireUrls).toEqual([
      setupUrl,
    ])
  })

  it('collects Clerum OAuth separately from the queued Evenfire links', () => {
    const result = collectInitialProtocolUrls([
      'Evenfire',
      'evenfire://app/sandbox-recipes/task-board?path=%2Ftasks',
      'clerum://oauth-completed?clientId=github&provider=github',
      'clerum://oauth-completed?clientId=slack&provider=slack',
      'clerum://oauth-completed?clientId=github&provider=github',
      '--unrelated',
    ])

    expect(result).toEqual({
      evenfireUrls: ['evenfire://app/sandbox-recipes/task-board?path=%2Ftasks'],
      clerumUrls: [
        'clerum://oauth-completed?clientId=github&provider=github',
        'clerum://oauth-completed?clientId=slack&provider=slack',
      ],
    })
  })
})
