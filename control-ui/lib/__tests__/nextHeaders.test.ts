import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match'
import { describe, expect, it } from 'vitest'
import nextConfig from '../../next.config.js'

const FRAME_HEADERS = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
]

/** The header rules Next applies to `pathname`, matched as Next matches a header `source`. */
async function frameRulesFor(pathname: string) {
  const rules = (await nextConfig.headers?.()) ?? []
  return rules.filter(
    rule =>
      getPathMatch(rule.source, { strict: false })(pathname) !== false &&
      FRAME_HEADERS.every(frame =>
        rule.headers.some(header => header.key === frame.key && header.value === frame.value)
      )
  )
}

describe('next.config headers', () => {
  it.each([
    '/',
    '/agents',
    '/agents/foo/approvals',
    '/connectors',
    '/marketplace/connectors',
    '/settings/ui',
    '/control-api',
    '/control-api-docs',
    '/control-apis/foo',
  ])('sets frame-ancestors none and X-Frame-Options DENY on the page %s', async pathname => {
    const rules = await frameRulesFor(pathname)
    expect(rules).toHaveLength(1)
    expect(rules[0].headers).toEqual(expect.arrayContaining(FRAME_HEADERS))
  })

  // Config headers are set on the response before a route handler runs, and a
  // handler's own header of the same name is then dropped (Next's
  // send-response). The proxy under /control-api/ forwards upstream headers,
  // so a CSP or X-Frame-Options from control-api must not be suppressed.
  it.each(['/control-api/', '/control-api/api/v1/admin/hosts/foo'])(
    'leaves the proxied path %s out of the frame rule',
    async pathname => {
      expect(await frameRulesFor(pathname)).toEqual([])
    }
  )
})
