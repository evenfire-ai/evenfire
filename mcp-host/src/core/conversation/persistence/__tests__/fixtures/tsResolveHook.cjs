// Lets a child `node --experimental-transform-types` process require the
// TypeScript sources directly: resolves extensionless relative imports made
// from a .ts file to `<path>.ts` or `<path>/index.ts`.
const fs = require('node:fs')
const path = require('node:path')
const { registerHooks } = require('node:module')
const { fileURLToPath } = require('node:url')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts')) {
      const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
      for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate)) return nextResolve(candidate, context)
      }
    }
    return nextResolve(specifier, context)
  },
})
