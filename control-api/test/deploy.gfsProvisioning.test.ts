import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

function read(relativeFromRepoRoot: string): string {
  return readFileSync(new URL(relativeFromRepoRoot, import.meta.url), 'utf-8')
}

describe('deploy/scripts/provision-gfs-db.sh', () => {
  const script = read('../../deploy/scripts/provision-gfs-db.sh')

  it('keeps process argv free of generated connection material', () => {
    expect(script).toContain('exec -i "$PG_DEPLOY" -- psql')
    expect(script).toContain('-f - <<SQL')
    expect(script).toContain('--patch-file=/dev/stdin')
    expect(script).not.toContain(' -c \\')
    expect(script).not.toContain('-p "$patch"')
    expect(script).not.toContain(`CONN="$${'D'}${'SN'}"`)
  })

  it('fails loud when gfsc rollout status fails', () => {
    const rolloutLine = script
      .split('\n')
      .find(line => line.includes('rollout status deployment -l "$GFS_DEPLOY_SELECTOR"'))

    expect(rolloutLine).toBeDefined()
    expect(rolloutLine).not.toContain('|| true')
  })
})
