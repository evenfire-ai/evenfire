import { Router } from 'express'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireInternalControlJwt } from '../../middleware/internalControlJwt.js'
import {
  finalizePluginWorkloadSdkRevocation,
  revokePluginWorkloadSdkForRecipe,
} from '../../services/pluginWorkloadSdkDb.js'
import { isPlainObject } from '../../utils/isPlainObject.js'

function recipeBinding(body: unknown): { recipeNamespace: string; recipeName: string } | null {
  if (!isPlainObject(body)) return null
  const recipeNamespace =
    typeof body.recipeNamespace === 'string' ? body.recipeNamespace.trim() : ''
  const recipeName = typeof body.recipeName === 'string' ? body.recipeName.trim() : ''
  if (!recipeNamespace || !recipeName || recipeNamespace.length > 253 || recipeName.length > 253) {
    return null
  }
  return { recipeNamespace, recipeName }
}

const REVOCATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function revocationId(body: unknown): string | null {
  if (!isPlainObject(body) || typeof body.revocationId !== 'string') return null
  const value = body.revocationId.trim()
  return REVOCATION_ID_RE.test(value) ? value : null
}

/**
 * WRC-only revocation boundary for SDK-only recipe teardown. The first call
 * fences Control API authorization and active generations; the second call is
 * accepted only after WRC has proved the endpoint/pod/secrets are absent.
 */
export function createInternalPluginWorkloadSdkRouter(): Router {
  const router = Router()
  router.post(
    '/internal/plugin-workload-sdk/revoke',
    requireInternalControlJwt,
    asyncHandler(async (req, res) => {
      const internalControl = req.internalControl
      if (internalControl?.iss !== 'wrc' || internalControl.sub !== 'wrc-provisioner') {
        res.status(403).json({ error: 'internal issuer not allowed' })
        return
      }
      const binding = recipeBinding(req.body)
      if (!binding) {
        res.status(400).json({ error: 'recipeNamespace and recipeName are required' })
        return
      }
      const result = await revokePluginWorkloadSdkForRecipe(
        binding.recipeNamespace,
        binding.recipeName,
        internalControl.sub
      )
      res.status(200).json(result)
    })
  )

  router.post(
    '/internal/plugin-workload-sdk/finalize-revocation',
    requireInternalControlJwt,
    asyncHandler(async (req, res) => {
      const internalControl = req.internalControl
      if (internalControl?.iss !== 'wrc' || internalControl.sub !== 'wrc-provisioner') {
        res.status(403).json({ error: 'internal issuer not allowed' })
        return
      }
      const binding = recipeBinding(req.body)
      const expectedRevocationId = revocationId(req.body)
      if (!binding || !expectedRevocationId) {
        res.status(400).json({ error: 'recipeNamespace, recipeName and revocationId are required' })
        return
      }
      const result = await finalizePluginWorkloadSdkRevocation(
        binding.recipeNamespace,
        binding.recipeName,
        expectedRevocationId,
        internalControl.sub
      )
      res.status(result.state === 'conflict' ? 409 : 200).json(result)
    })
  )

  return router
}
