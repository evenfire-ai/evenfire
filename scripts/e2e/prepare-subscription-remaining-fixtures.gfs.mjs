// E2E_GUARDIAN_IPC_FLOW: data preparation only. Authentication is the existing
// in-pod PrivateCookieSession; it never leaves that process or advances UI.

/**
 * Self-contained so the existing seeder can include this exact function in its
 * in-pod bundle. `session.request` is the real Control API CookieGuard client:
 * JSON returns {status,json}; binary returns {status,bytes}, bounded by it.
 */
export async function prepareGfsImages({ session, userId, hostNamespace, hostRef,
  parentResourceId, folderName, files }) {
  const { createHash } = await import('node:crypto')
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  const dns = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
  const rid = value => typeof value === 'string' ? value.replaceAll('-', '').toLowerCase() : ''
  const fail = code => { throw new Error(code) }
  if (typeof session?.request !== 'function' || !uuid.test(userId ?? '') ||
      !uuid.test(parentResourceId ?? '') || !dns.test(hostNamespace ?? '') || !dns.test(hostRef ?? '') ||
      !/^e2e-gfs-[a-z0-9-]{1,96}$/.test(folderName ?? '') || !Array.isArray(files) || files.length !== 2) {
    fail('GFS_PREPARE_INPUT_INVALID')
  }
  const names = new Set(), hashes = new Set()
  const inputs = files.map(file => {
    if (!file || !/^[a-f0-9-]{36}\.(?:png|jpeg)$/.test(file.name ?? '') ||
        !['image/png', 'image/jpeg'].includes(file.mimeType) ||
        typeof file.contentBase64 !== 'string' || file.contentBase64.length > 4 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) fail('GFS_PREPARE_IMAGE_INVALID')
    const bytes = Buffer.from(file.contentBase64, 'base64')
    if (!bytes.length || bytes.length > 3 * 1024 * 1024 || bytes.toString('base64') !== file.contentBase64 ||
        sha256(bytes) !== file.sha256 ||
        (file.mimeType === 'image/png' && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
        (file.mimeType === 'image/jpeg' && !bytes.subarray(0, 3).equals(Buffer.from([255,216,255])))) {
      fail('GFS_PREPARE_IMAGE_INVALID')
    }
    names.add(file.name); hashes.add(file.sha256)
    return { ...file, bytes }
  })
  if (names.size !== 2 || hashes.size !== 2) fail('GFS_PREPARE_IMAGES_NOT_INDEPENDENT')
  const drive = 'main'
  // Native Control API only: its CookieGuard proxy fixes drive=main and
  // delegates these operations to the actual gfsc writer. No direct gfsc URL.
  const resourcePath = resourceId => `/api/v1/gfs/proxy/v1/resources/${rid(resourceId)}`
  const unwrap = (response, status) => {
    if (response?.status !== status || response.json?.ok !== true ||
        !response.json.data || typeof response.json.data !== 'object' || Array.isArray(response.json.data)) {
      fail('GFS_PREPARE_API_REFUSED')
    }
    return response.json.data
  }
  const verifyResource = (value, expected) => {
    if (!uuid.test(value?.resourceId ?? '') || value.drive !== drive || value.rid !== rid(value.resourceId) ||
        value.gfsUri !== `gfs://${drive}/${value.rid}` || value.kind !== expected.kind || value.name !== expected.name ||
        rid(value.parentResourceId) !== rid(expected.parentResourceId) ||
        !Number.isSafeInteger(value.version) || value.version < 0 ||
        !Number.isSafeInteger(value.bytes) || value.bytes < 0) fail('GFS_PREPARE_RESOURCE_INVALID')
    return value
  }
  const folder = verifyResource(unwrap(await session.request({
    method: 'POST', path: `${resourcePath(parentResourceId)}/children`,
    body: { name: folderName, kind: 'directory' }, binary: false,
  }), 201), { name: folderName, kind: 'directory', parentResourceId })
  if (typeof folder.path !== 'string' || !folder.path.startsWith('/')) fail('GFS_PREPARE_FOLDER_PATH_INVALID')
  const folderNames = folder.path.split('/').filter(Boolean)
  if (!folderNames.length || folderNames.length > 8 || folderNames[folderNames.length - 1] !== folderName ||
      folderNames.some(name => name.length > 128 || /[\x00-\x1f/\\]/.test(name) || name === '.' || name === '..')) {
    fail('GFS_PREPARE_FOLDER_PATH_INVALID')
  }
  const hostSubject = `1st:${hostNamespace}/${hostRef}`
  const subjects = [{ type: 'user', id: userId }, { type: 'host', id: hostSubject }]
  const grant = await session.request({ method: 'PUT', path: '/api/v1/gfs/grants', binary: false,
    body: { drive, resourceId: folder.resourceId, subjects, permissions: ['read'], inherit: true } })
  if (grant?.status !== 200 || grant.json?.ok !== true || grant.json.count !== 2) fail('GFS_PREPARE_GRANT_REFUSED')
  const grants = await session.request({ method: 'GET',
    path: `/api/v1/gfs/grants?drive=${drive}&resourceId=${encodeURIComponent(folder.resourceId)}`, binary: false })
  if (grants?.status !== 200 || !Array.isArray(grants.json?.items)) fail('GFS_PREPARE_GRANT_WITNESS_MISSING')
  for (const subject of subjects) {
    const rows = grants.json.items.filter(row => rid(row.resourceId) === rid(folder.resourceId) && row.drive === drive &&
      row.subject?.type === subject.type && row.subject?.id === subject.id)
    if (rows.length !== 1 || rows[0].inherit !== true || !rows[0].permissions?.includes('read')) {
      fail('GFS_PREPARE_GRANT_WITNESS_MISSING')
    }
  }
  const prepared = []
  for (const file of inputs) {
    const resource = verifyResource(unwrap(await session.request({ method: 'POST',
      path: `${resourcePath(folder.resourceId)}/children`, binary: false,
      body: { name: file.name, kind: 'file', contentBase64: file.contentBase64 },
    }), 201), { name: file.name, kind: 'file', parentResourceId: folder.resourceId })
    if (resource.bytes !== file.bytes.length) fail('GFS_PREPARE_BYTE_COUNT_MISMATCH')
    const content = await session.request({ method: 'GET', path: `${resourcePath(resource.resourceId)}/content`, binary: true })
    if (content?.status !== 200 || !Buffer.isBuffer(content.bytes) || content.bytes.length !== file.bytes.length ||
        sha256(content.bytes) !== file.sha256) fail('GFS_PREPARE_CONTENT_MISMATCH')
    const fresh = verifyResource(unwrap(await session.request({ method: 'GET',
      path: resourcePath(resource.resourceId), binary: false,
    }), 200), { name: file.name, kind: 'file', parentResourceId: folder.resourceId })
    if (fresh.version !== resource.version || fresh.bytes !== resource.bytes || fresh.resourceId !== resource.resourceId) {
      fail('GFS_PREPARE_SOURCE_CHANGED')
    }
    prepared.push({ name: fresh.name, drive, pickerResourceId: fresh.resourceId,
      resourceId: fresh.rid, gfsUri: fresh.gfsUri, version: fresh.version, sizeBytes: fresh.bytes,
      mimeType: file.mimeType, imageSha256: file.sha256, width: 512, height: 512 })
  }
  return { folderNames, folderResourceId: folder.resourceId, hostSubject, userId, files: prepared,
    evidence: { createStatus: 201, contentStatus: 200, metadataStatus: 200, grantStatus: 200,
      grantSubjects: subjects, inheritedRead: true } }
}
