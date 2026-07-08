import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

describe('workflow approval request reader entrypoint contract', () => {
  it('keeps server module import-safe and starts only from main entrypoint', () => {
    const serverSource = read('src/server.ts')
    const mainSource = read('src/main.ts')
    const packageJson = JSON.parse(read('package.json')) as {
      main?: string
      scripts?: Record<string, string>
    }
    const dockerfile = read('Dockerfile')

    expect(serverSource).not.toContain('NODE_ENV')
    expect(serverSource).not.toContain('.listen(')

    expect(mainSource).toContain("import { createServer } from './server.js'")
    expect(mainSource).toContain('createServer().listen')

    expect(packageJson.main).toBe('dist/main.js')
    expect(packageJson.scripts?.start).toBe('node dist/main.js')
    expect(dockerfile).toContain('CMD ["node", "dist/main.js"]')
  })
})
