/**
 * Loads control-api TypeScript modules straight from source, so the seed applies
 * the exact rules control-api applies when it reads a catalog entry, never a copy
 * that can drift from them.
 *
 * Why source and not `control-api/dist`: `dist` only exists after a build, can be
 * stale against the checkout the catalog is reviewed in, and CI does not build
 * control-api before the script tests. Node (>= 22.18 / 24, the version control-api
 * pins) strips TypeScript types natively; the only gap is that control-api writes
 * its relative imports with a `.js` suffix for `tsc`, so a resolve hook maps them to
 * the `.ts` file next to them. The hook is scoped to files under `control-api/` and
 * nothing else in the process is affected.
 *
 * Only erasable TypeScript loads this way. If a loaded module (or one it imports)
 * starts using enums, namespaces or parameter properties, the import fails with
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX naming the file.
 */
import { existsSync } from 'node:fs'
import * as nodeModule from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CONTROL_API_DIR = fileURLToPath(new URL('../../../control-api/', import.meta.url))
const CONTROL_API_URL = pathToFileURL(CONTROL_API_DIR).href

let hookInstalled = false

function installTypeScriptResolveHook() {
  if (hookInstalled) return
  if (typeof nodeModule.registerHooks !== 'function' || !process.features?.typescript) {
    throw new Error(
      `Node ${process.version} cannot load control-api's TypeScript sources: ` +
        'use the Node version control-api pins (>= 24, with type stripping enabled).'
    )
  }
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL
      if (
        parent?.startsWith(CONTROL_API_URL) &&
        parent.endsWith('.ts') &&
        /^\.\.?\//.test(specifier) &&
        specifier.endsWith('.js')
      ) {
        const tsUrl = new URL(`${specifier.slice(0, -3)}.ts`, parent)
        if (existsSync(fileURLToPath(tsUrl))) {
          return { url: tsUrl.href, format: 'module-typescript', shortCircuit: true }
        }
      }
      const resolved = nextResolve(specifier, context)
      // control-api's package.json declares no module type; naming the format
      // avoids Node's reparse-as-ESM fallback and the warning it prints.
      if (resolved.url.startsWith(CONTROL_API_URL) && resolved.url.endsWith('.ts')) {
        return { ...resolved, format: 'module-typescript' }
      }
      return resolved
    },
  })
  hookInstalled = true
}

/** Imports a control-api source module by its path relative to `control-api/`. */
export async function loadControlApiModule(relativePath) {
  const absolute = path.join(CONTROL_API_DIR, relativePath)
  if (!existsSync(absolute)) {
    throw new Error(
      `control-api module not found: ${absolute}. Run the seed from a full evenfire checkout.`
    )
  }
  installTypeScriptResolveHook()
  return import(pathToFileURL(absolute).href)
}

/**
 * The remote-OAuth catalog rules the seed reuses: the semantic validator every
 * catalog read applies, and the drift comparison `/discover` reports.
 */
export async function loadRemoteOAuthRules() {
  const mod = await loadControlApiModule('src/routes/admin/catalogRemoteOAuth.ts')
  for (const fn of ['parseRemoteOAuthCatalogBlock', 'catalogRegistrationDrifts']) {
    if (typeof mod[fn] !== 'function') {
      throw new Error(`control-api catalogRemoteOAuth.ts no longer exports ${fn}`)
    }
  }
  return {
    parseRemoteOAuthCatalogBlock: mod.parseRemoteOAuthCatalogBlock,
    catalogRegistrationDrifts: mod.catalogRegistrationDrifts,
  }
}
