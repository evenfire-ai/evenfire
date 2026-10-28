'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  GFS_INHERITED_WALK_MAX_DEPTH,
  classifyGfsAclReadFailure,
  gfsAncestorPathsOf,
  gfsHttpStatusOf,
  gfsRetryAfterSecondsOf,
  gfsRoleRank,
  gfsSubjectKeyOf,
  isEditorGfsPermissions,
  mergeGfsInheritedAccessItem,
  planGfsInheritedRoleChange,
  strongestGfsInheritedSource,
  worstGfsCoverageClass,
} = require('./inheritedAccess.cjs')

const folder = (resourceId, name) => ({ resourceId, name })
const grantContribution = (subject, permissions, rowId, inherit = true) => ({
  subject,
  permissions,
  rowKind: 'grant',
  rowId,
  inherit,
})
const shareContribution = (subject, permissions, rowId, includeDescendants = true) => ({
  subject,
  permissions,
  rowKind: 'share',
  rowId,
  includeDescendants,
})
const userA = { type: 'user', id: 'user-a' }
const userB = { type: 'user', id: 'user-b' }

describe('gfsSubjectKeyOf', () => {
  it('operator carries no id segment', () => {
    assert.equal(gfsSubjectKeyOf({ type: 'operator' }), 'operator:')
  })
  it('team and user keys are distinct even for the same human', () => {
    assert.notEqual(
      gfsSubjectKeyOf({ type: 'user', id: 'x' }),
      gfsSubjectKeyOf({ type: 'team', id: 'x' })
    )
  })
})

describe('gfsAncestorPathsOf', () => {
  it('nearest ancestor first ending at the drive root', () => {
    assert.deepEqual(gfsAncestorPathsOf('/docs/report.md'), ['/docs', '/'])
  })
  it('a root-level resource has exactly the root folder as its ancestor', () => {
    // The Control UI anchor pushes the drive root unconditionally: a file at
    // /report.md is covered by the root folder's inheriting grants.
    assert.deepEqual(gfsAncestorPathsOf('/report.md'), ['/'])
  })
  it('the root folder itself has no ancestors', () => {
    assert.deepEqual(gfsAncestorPathsOf('/'), [])
  })
  it('depth is capped at the walk bound, keeping the NEAREST ancestors', () => {
    // 100 directories + leaf = 101 segments → 101 ancestors before the cap;
    // the first 64 kept are counts 100..37, so the last kept path has the
    // first 37 segments (d0..d36).
    const deep = `/${Array.from({ length: 100 }, (_, i) => `d${i}`).join('/')}/leaf.md`
    const ancestors = gfsAncestorPathsOf(deep)
    assert.equal(ancestors.length, GFS_INHERITED_WALK_MAX_DEPTH)
    assert.equal(ancestors.at(-1), `/${Array.from({ length: 37 }, (_, i) => `d${i}`).join('/')}`)
  })
})

describe('gfsHttpStatusOf / gfsRetryAfterSecondsOf', () => {
  it('structured status wins over message text', () => {
    assert.equal(gfsHttpStatusOf({ status: 403 }), 403)
    assert.equal(gfsHttpStatusOf({ response: { status: 429 } }), 429)
  })
  it('reads the vetted main-process markers and leading status lines', () => {
    assert.equal(gfsHttpStatusOf(new Error('Forbidden httpStatus=403')), 403)
    assert.equal(gfsHttpStatusOf(new Error('429 Too Many Requests: slow down')), 429)
    assert.equal(gfsHttpStatusOf(new Error('no status here')), null)
  })
  it('retry window is read from the trailing marker and clamped', () => {
    assert.equal(gfsRetryAfterSecondsOf(new Error('rate limited retryAfterSeconds=7')), 7)
    assert.equal(gfsRetryAfterSecondsOf(new Error('retryAfterSeconds=9000')), 300)
    assert.equal(gfsRetryAfterSecondsOf(new Error('no window')), null)
  })
})

describe('classifyGfsAclReadFailure', () => {
  it('401/403 are denied privacy boundaries, not session failures', () => {
    assert.equal(classifyGfsAclReadFailure({ status: 403 }), 'denied')
    assert.equal(classifyGfsAclReadFailure(new Error('401 Unauthorized')), 'denied')
  })
  it('404/410 are missing, 429 rate-limited, 5xx/transport retryable', () => {
    assert.equal(classifyGfsAclReadFailure({ status: 404 }), 'missing')
    assert.equal(classifyGfsAclReadFailure({ status: 410 }), 'missing')
    assert.equal(classifyGfsAclReadFailure({ status: 429 }), 'rate-limited')
    assert.equal(classifyGfsAclReadFailure({ status: 503 }), 'retryable')
    assert.equal(classifyGfsAclReadFailure(new TypeError('fetch failed')), 'retryable')
    assert.equal(classifyGfsAclReadFailure(new Error('socket hang up')), 'retryable')
  })
  it('unexpected shapes stay errors', () => {
    assert.equal(classifyGfsAclReadFailure(new Error('boom')), 'error')
    assert.equal(classifyGfsAclReadFailure({ status: 400 }), 'error')
  })
})

describe('mergeGfsInheritedAccessItem', () => {
  it('creates the subject on first sight with exact row provenance', () => {
    const item = mergeGfsInheritedAccessItem(
      null,
      grantContribution(userA, ['read', 'write'], 'g1', true),
      folder('f1', 'Projects')
    )
    assert.equal(item.subject, userA)
    assert.deepEqual(item.permissions, ['read', 'write'])
    assert.equal(item.sources[0].grantId, 'g1')
    assert.equal(item.sources[0].grantInherit, true)
    assert.deepEqual(item.sources[0].grantPermissions, ['read', 'write'])
    assert.deepEqual(item.sources[0].shareEntries, [])
  })

  it('folding a provenance-projected source back in is safe and idempotent', () => {
    // App adapters feed their legacy-exact shape (no grantPermissions /
    // grantInherit / shareEntries) back through the core; the core must treat
    // those missing optional fields as empty rather than crash.
    let item = mergeGfsInheritedAccessItem(
      null,
      grantContribution(userA, ['read'], 'g1', true),
      folder('f1', 'Projects')
    )
    const projected = {
      subject: item.subject,
      permissions: [...item.permissions],
      inheritedFrom: [...item.inheritedFrom],
      sources: item.sources.map(source => ({
        resourceId: source.resourceId,
        name: source.name,
        permissions: [...source.permissions],
        grantId: source.grantId,
        shareIds: [...source.shareIds],
      })),
    }
    const refolded = mergeGfsInheritedAccessItem(
      projected,
      shareContribution(userA, ['read'], 's1', true),
      folder('f1', 'Projects')
    )
    assert.equal(refolded.sources.length, 1)
    assert.deepEqual(refolded.sources[0].shareIds, ['s1'])
    assert.deepEqual(refolded.sources[0].shareEntries, [
      { rowId: 's1', permissions: ['read'], includeDescendants: true },
    ])
    const again = mergeGfsInheritedAccessItem(
      refolded,
      shareContribution(userA, ['read'], 's1', true),
      folder('f1', 'Projects')
    )
    assert.deepEqual(again, refolded)
  })

  it('rowless observations fold permissions without touching row ids or flags', () => {
    let item = mergeGfsInheritedAccessItem(
      null,
      grantContribution(userA, ['read'], 'g1', true),
      folder('f1', 'Projects')
    )
    item = mergeGfsInheritedAccessItem(
      item,
      { subject: userA, permissions: ['write'], rowKind: 'grant', rowId: null },
      folder('f1', 'Projects')
    )
    item = mergeGfsInheritedAccessItem(
      item,
      { subject: userA, permissions: ['share'], rowKind: 'share', rowId: null },
      folder('f1', 'Projects')
    )
    assert.equal(item.sources.length, 1)
    assert.deepEqual(item.permissions.sort(), ['read', 'share', 'write'])
    assert.equal(item.sources[0].grantId, 'g1')
    assert.equal(item.sources[0].grantInherit, true)
    assert.deepEqual(item.sources[0].grantPermissions, ['read'])
    assert.deepEqual(item.sources[0].shareIds, [])
    assert.deepEqual(item.sources[0].shareEntries, [])
    // A rowless first observation creates the source with no row handles.
    const bare = mergeGfsInheritedAccessItem(
      null,
      { subject: userB, permissions: ['read'], rowKind: 'grant', rowId: null },
      folder('f1', 'Projects')
    )
    assert.equal(bare.subject, userB)
    assert.equal(bare.sources[0].grantId, null)
    assert.deepEqual(bare.sources[0].shareIds, [])
    assert.deepEqual(bare.sources[0].permissions, ['read'])
  })

  it('same folder grant + share consolidate, keeping each row separately addressable', () => {
    let item = mergeGfsInheritedAccessItem(
      null,
      grantContribution(userA, ['read', 'write'], 'g1', true),
      folder('f1', 'Projects')
    )
    item = mergeGfsInheritedAccessItem(
      item,
      shareContribution(userA, ['read'], 's1', true),
      folder('f1', 'Projects')
    )
    assert.equal(item.sources.length, 1)
    assert.equal(item.sources[0].grantId, 'g1')
    assert.deepEqual(item.sources[0].shareIds, ['s1'])
    assert.deepEqual(item.sources[0].permissions, ['read', 'write'])
    assert.deepEqual(item.sources[0].shareEntries, [
      { rowId: 's1', permissions: ['read'], includeDescendants: true },
    ])
  })

  it('every contributing folder survives: idempotent, no source dropped, inputs untouched', () => {
    const first = mergeGfsInheritedAccessItem(
      null,
      grantContribution(userA, ['read'], 'g1', true),
      folder('f1', 'Projects')
    )
    const second = mergeGfsInheritedAccessItem(
      first,
      grantContribution(userA, ['read', 'manage_acl'], 'g2', false),
      folder('f2', 'Archive')
    )
    const again = mergeGfsInheritedAccessItem(
      second,
      grantContribution(userA, ['read'], 'g1', true),
      folder('f1', 'Projects')
    )
    assert.equal(again.sources.length, 2)
    assert.deepEqual(
      again.sources.map(source => source.resourceId),
      ['f1', 'f2']
    )
    assert.equal(again.sources[0].grantId, 'g1')
    assert.equal(again.sources[0].grantInherit, true)
    assert.equal(again.sources[1].grantId, 'g2')
    assert.equal(again.sources[1].grantInherit, false)
    assert.deepEqual(first.permissions, ['read'])
    assert.equal(first.sources.length, 1)
  })

  it('subjects never merge across keys', () => {
    let items = mergeGfsInheritedAccessItem(
      null,
      grantContribution(userA, ['read'], 'g1', true),
      folder('f1', 'Projects')
    )
    items = mergeGfsInheritedAccessItem(
      items,
      grantContribution(userB, ['read'], 'g2', true),
      folder('f1', 'Projects')
    )
    assert.equal(items.subject, userA)
    assert.equal(items.sources.length, 1)
    assert.equal(gfsSubjectKeyOf(items.subject), gfsSubjectKeyOf(userA))
  })

  it('property: folding is idempotent and the union only grows', () => {
    // Wire-faithful input: the server's UNIQUE (drive, resource, subject)
    // constraint allows at most ONE grant per subject+folder, so a folder's
    // contributions for one subject are one grant plus any number of shares.
    const contributions = [
      grantContribution(userA, ['read'], 'g1', true),
      shareContribution(userA, ['read', 'share'], 's1', false),
      shareContribution(userA, ['read', 'write'], 's2', true),
    ]
    let folded = null
    for (let round = 0; round < 3; round += 1) {
      for (const contribution of contributions) {
        folded = mergeGfsInheritedAccessItem(folded, contribution, folder('f1', 'Projects'))
      }
    }
    assert.equal(folded.sources.length, 1)
    assert.equal(folded.sources[0].grantId, 'g1')
    assert.deepEqual(folded.sources[0].shareIds.sort(), ['s1', 's2'])
    assert.equal(folded.sources[0].grantInherit, true)
    assert.equal(folded.sources[0].shareEntries.length, 2)
    for (const permission of ['read', 'write', 'share']) {
      assert.ok(folded.permissions.includes(permission))
    }
  })
})

describe('planGfsInheritedRoleChange', () => {
  it('no-op when the target equals the effective role', () => {
    const item = { permissions: ['read', 'write'], sources: [] }
    assert.deepEqual(planGfsInheritedRoleChange(item, true), {
      grantSources: [],
      shareOnlySources: [],
    })
  })

  it('downgrade plans every editor grant source and discloses share-only editors', () => {
    const item = {
      permissions: ['read', 'write'],
      sources: [
        {
          resourceId: 'f1',
          name: 'A',
          permissions: ['read', 'write'],
          grantId: 'g1',
          shareIds: [],
          grantPermissions: ['read', 'write'],
          grantInherit: true,
          shareEntries: [],
        },
        {
          resourceId: 'f2',
          name: 'B',
          permissions: ['read'],
          grantId: 'g2',
          shareIds: [],
          grantPermissions: ['read'],
          grantInherit: true,
          shareEntries: [],
        },
        {
          resourceId: 'f3',
          name: 'C',
          permissions: ['read', 'write'],
          grantId: null,
          shareIds: ['s1'],
          grantPermissions: null,
          grantInherit: null,
          shareEntries: [{ rowId: 's1', permissions: ['read', 'write'], includeDescendants: true }],
        },
      ],
    }
    const plan = planGfsInheritedRoleChange(item, false)
    assert.deepEqual(
      plan.grantSources.map(source => source.resourceId),
      ['f1']
    )
    assert.deepEqual(
      plan.shareOnlySources.map(source => source.resourceId),
      ['f3']
    )
  })

  it('upgrade raises the strongest source, preferring an editable grant when the strongest is a share', () => {
    // Effective role is Read (both sources read-strength), so an upgrade
    // plans. The nearest/strongest source (tie broken nearest-first) is the
    // share, which this release cannot edit — the plan raises the strongest
    // grant-backed source instead and discloses the share residual.
    const sources = [
      {
        resourceId: 'f2',
        name: 'B',
        permissions: ['read'],
        grantId: null,
        shareIds: ['s1'],
        grantPermissions: null,
        grantInherit: null,
        shareEntries: [{ rowId: 's1', permissions: ['read'], includeDescendants: true }],
      },
      {
        resourceId: 'f1',
        name: 'A',
        permissions: ['read'],
        grantId: 'g1',
        shareIds: [],
        grantPermissions: ['read'],
        grantInherit: false,
        shareEntries: [],
      },
    ]
    const plan = planGfsInheritedRoleChange({ permissions: ['read'], sources }, true)
    assert.deepEqual(
      plan.grantSources.map(source => source.resourceId),
      ['f1']
    )
    assert.deepEqual(
      plan.shareOnlySources.map(source => source.resourceId),
      ['f2']
    )
  })

  it('an editor-strength share already makes the effective role editor, so an editor upgrade is a no-op', () => {
    const sources = [
      {
        resourceId: 'f1',
        name: 'A',
        permissions: ['read'],
        grantId: 'g1',
        shareIds: [],
        grantPermissions: ['read'],
        grantInherit: false,
        shareEntries: [],
      },
      {
        resourceId: 'f2',
        name: 'B',
        permissions: ['read', 'write'],
        grantId: null,
        shareIds: ['s1'],
        grantPermissions: null,
        grantInherit: null,
        shareEntries: [{ rowId: 's1', permissions: ['read', 'write'], includeDescendants: true }],
      },
    ]
    assert.deepEqual(
      planGfsInheritedRoleChange({ permissions: ['read', 'write'], sources }, true),
      {
        grantSources: [],
        shareOnlySources: [],
      }
    )
  })

  it('strongest grant-backed source wins the upgrade when several are editable', () => {
    const sources = [
      {
        resourceId: 'f1',
        name: 'A',
        permissions: ['read'],
        grantId: 'g1',
        shareIds: [],
        grantPermissions: ['read'],
        grantInherit: true,
        shareEntries: [],
      },
      {
        resourceId: 'f2',
        name: 'B',
        permissions: ['read', 'write'],
        grantId: 'g2',
        shareIds: [],
        grantPermissions: ['read', 'write'],
        grantInherit: true,
        shareEntries: [],
      },
    ]
    const plan = planGfsInheritedRoleChange({ permissions: ['read'], sources }, true)
    assert.deepEqual(
      plan.grantSources.map(source => source.resourceId),
      ['f2']
    )
  })
})

describe('role helpers and coverage ordering', () => {
  it('editor detection covers write/delete/manage_acl only', () => {
    assert.equal(isEditorGfsPermissions(['read', 'share']), false)
    assert.equal(isEditorGfsPermissions(['read', 'delete']), true)
    assert.equal(gfsRoleRank(['read']), 0)
    assert.equal(gfsRoleRank(['manage_acl']), 1)
  })
  it('strongest source: editor beats read, nearest among equals', () => {
    const sources = [
      {
        resourceId: 'f1',
        name: 'A',
        permissions: ['read', 'write'],
        grantId: 'g1',
        shareIds: [],
        grantPermissions: null,
        grantInherit: null,
        shareEntries: [],
      },
      {
        resourceId: 'f2',
        name: 'B',
        permissions: ['read'],
        grantId: 'g2',
        shareIds: [],
        grantPermissions: null,
        grantInherit: null,
        shareEntries: [],
      },
    ]
    assert.equal(strongestGfsInheritedSource(sources).resourceId, 'f1')
    assert.equal(strongestGfsInheritedSource([]), null)
  })
  it('worst-first coverage combination', () => {
    assert.equal(worstGfsCoverageClass(['complete', 'denied', 'complete']), 'denied')
    assert.equal(worstGfsCoverageClass(['rate-limited', 'denied']), 'rate-limited')
    assert.equal(worstGfsCoverageClass(['complete']), 'complete')
    assert.equal(worstGfsCoverageClass([]), 'complete')
  })
})
