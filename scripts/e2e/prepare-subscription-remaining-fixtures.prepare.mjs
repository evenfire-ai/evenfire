// E2E_GUARDIAN_IPC_FLOW: caller is Main's leased coordinator. The existing
// seeder owns login/session and server config; this prepares only QA assets.
import { createRemainingPixelAssets, buildRemainingFixtureFrame, remainingAssetPath } from './prepare-subscription-remaining-fixtures.mjs'
import { observeQaHostRuntime, prepareQaScreen } from './prepare-subscription-remaining-fixtures.runtime.mjs'

/**
 * `hostBindings` contains actual names/UIDs returned by the existing seeder.
 * `prepareGfs` dispatches its real prepare-gfs-images action in that same
 * authenticated process, implemented by prepare-subscription-remaining-fixtures.gfs.mjs.
 * `pressure` is the actual Main pressure publication/inspector result, not a
 * proposed policy. No credential, session, cookie or JWT enters this output.
 */
export async function prepareRemainingFixtures({ admission, runRoot, hostBindings, prepareGfs, pressure }) {
  const assets = createRemainingPixelAssets({ admission, runRoot })
  if (!Array.isArray(hostBindings) || hostBindings.length !== 2) throw new Error('REMAINING_PREPARE_ACTUAL_HOST_BINDINGS_REQUIRED')
  const fixtures = {}, evidence = {}
  for (const binding of admission.bindings) {
    const actual = hostBindings.filter(item => item.hostRef === binding.hostRef)
    if (actual.length !== 1) throw new Error('REMAINING_PREPARE_HOST_BINDING_AMBIGUOUS')
    const target = { context: admission.context, hostNamespace: actual[0].hostNamespace,
      hostRef: binding.hostRef, hostUid: actual[0].hostUid }
    const runtime = observeQaHostRuntime(target)
    const common = { hostRef: binding.hostRef, podUid: runtime.podUid, imageId: runtime.imageId }
    const selected = assets.filter(asset => asset.provider === binding.provider)
    if (admission.suiteId === 'tool-screenshot') {
      const asset = selected[0]
      const screen = await prepareQaScreen({ runtime, asset })
      fixtures[binding.provider] = { ...common, hostImagePath: screen.hostImagePath,
        fixtureImagePath: remainingAssetPath(runRoot, admission.suiteId, asset.name), imageSha256: asset.sha256,
        region: screen.region }
      evidence[binding.provider] = screen.evidence
    } else if (admission.suiteId === 'gfs-image') {
      if (typeof prepareGfs !== 'function') throw new Error('REMAINING_PREPARE_GFS_API_SESSION_REQUIRED')
      const result = await prepareGfs({ hostNamespace: runtime.hostNamespace, hostRef: binding.hostRef,
        folderName: `e2e-gfs-${admission.runId}-${binding.provider.startsWith('grok') ? 'grok' : 'codex'}`,
        files: selected.map(asset => ({ name: asset.name, mimeType: asset.mimeType,
          contentBase64: asset.contentsBase64, sha256: asset.sha256 })) })
      if (!Array.isArray(result?.files) || result.files.length !== 2) throw new Error('REMAINING_PREPARE_GFS_SOURCE_MISSING')
      const files = result.files.map(file => {
        const matches = selected.filter(asset => asset.name === file.name && asset.sha256 === file.imageSha256)
        if (matches.length !== 1) throw new Error('REMAINING_PREPARE_GFS_BYTES_MISMATCH')
        return { ...file, fixtureImagePath: remainingAssetPath(runRoot, admission.suiteId, matches[0].name) }
      })
      fixtures[binding.provider] = { ...common, folderNames: result.folderNames, files }
      evidence[binding.provider] = result.evidence
    } else {
      const other = admission.bindings.find(item => item.provider !== binding.provider)
      const configured = actual[0].fallback
      if (!pressure || pressure.profile !== admission.profile || pressure.context !== admission.context ||
          pressure.sourceManifestSha256 !== admission.sourceManifestSha256 ||
          !pressure.hostRefs?.includes(binding.hostRef) || configured?.provider !== other.provider ||
          configured?.modelId !== other.modelId ||
          !runtime.fallbacks.some(item => item.provider === configured.provider && item.model === configured.modelId)) {
        throw new Error('REMAINING_PREPARE_ACTUAL_PRESSURE_AND_FALLBACK_REQUIRED')
      }
      fixtures[binding.provider] = { ...common, controlApiPodUid: pressure.podUid,
        controlApiImageId: pressure.imageId, maxInFlight: pressure.maxInFlight,
        readDeadlineMs: pressure.readDeadlineMs, pressure: { receiptFile: pressure.receiptFile },
        fallback: { provider: configured.provider, modelId: configured.modelId } }
    }
    const fresh = observeQaHostRuntime(target)
    if (fresh.podUid !== runtime.podUid || fresh.imageId !== runtime.imageId || fresh.hostUid !== runtime.hostUid) {
      throw new Error('REMAINING_PREPARE_RUNTIME_CHANGED')
    }
  }
  const frame = await buildRemainingFixtureFrame({ admission, runRoot, fixtures, assets })
  return { frame, evidence }
}
