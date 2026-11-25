import { describe, expect, it } from 'vitest'
import nextConfig from '../../next.config.js'

describe('next.config headers', () => {
  it('headers() sets frame-ancestors none and X-Frame-Options DENY on every path', async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const everyPath = rules.filter(rule => rule.source === '/:path*')

    expect(everyPath).toHaveLength(1)
    expect(everyPath[0].headers).toEqual(
      expect.arrayContaining([
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        { key: 'X-Frame-Options', value: 'DENY' },
      ])
    )
  })
})
