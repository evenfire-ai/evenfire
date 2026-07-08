import { describe, expect, it, vi } from 'vitest'
import {
  WFC_BROWSING_READ_SCOPE,
  WFC_BROWSING_SCOPES,
  WFC_BROWSING_WRITE_SCOPE,
} from '../src/utils/auth/wfcBrowsingToken.js'

// wfcBrowsingToken imports ../../config.js at module load; stub it so this pure
// constant-contract test does not require runtime config/env.
vi.mock('../src/config.js', () => ({ config: {} }))

describe('wfc browsing scope wire contract', () => {
  // Cross-service contract with the workspace-files-controller (WFC_FILE_* in
  // workspace-files-controller/src/auth/jwtVerifier.ts). If either side drifts,
  // browsing tokens are rejected at runtime by the wfc scope checks. Keep both
  // lists in sync.
  it('pins the scope literals shared with the workspace-files-controller', () => {
    expect(WFC_BROWSING_READ_SCOPE).toBe('files:read')
    expect(WFC_BROWSING_WRITE_SCOPE).toBe('files:write')
    expect(WFC_BROWSING_SCOPES).toEqual(['files:read', 'files:write'])
  })
})
