// Property coverage for the Context replace planner (#568 review, zach88 R1-M2).
//
// `planContextReplacement` is the single source of truth for both the skip
// decision and the PUT body, so a defect in it is either a lost repair or a
// write storm. The example tests in mcpDelegation.test.ts pin named scenarios;
// these pin the INVARIANTS over random inputs, which is what "never shrinks the
// allowlist" and "converges" actually mean.
//
// The three that matter, and why:
//
//   no-shrink     a shared Context is multi-writer. If recipe A's pass could
//                 drop a server B declared, A would silently de-authorize B.
//   no-duplicates a duplicate in spec.mcpServers used to be permanent: the old
//                 sameMcpServerSet collapsed both sides to a Set and could
//                 never see it again (jozer-rami minors).
//   convergence   the planner must reach a fixed point. A plan that always
//                 reports "changed" is a write on every reconcile pass, for
//                 every recipe, forever — the #460 storm this PR closes.
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { planContextReplacement } from './mcpDelegation'

const ownerReference = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  name: 'test-recipe',
  uid: 'uid-abc-123',
  controller: true,
  blockOwnerDeletion: true,
}

/** Server names are DNS-ish labels; a small alphabet makes collisions frequent,
 *  which is the point — random unique strings would never exercise the dedupe. */
const serverName = fc.constantFrom('a-mcp', 'b-mcp', 'c-mcp', 'd-mcp')
const serverList = fc.array(serverName, { maxLength: 8 })

function planArgs(explicitContext: boolean, serverNames: readonly string[]) {
  return {
    contextName: 'context1',
    explicitContext,
    // Cross-namespace, so ownerReferences stay empty and the properties below
    // isolate the mcpServers merge rather than the ownership repair.
    sameNsAsRecipe: false,
    recipeName: 'test-recipe',
    serverNames,
    ownerReference,
  }
}

function liveContext(mcpServers: readonly string[], contextId = 'context1') {
  return {
    metadata: { resourceVersion: '1', labels: { 'clerum.io/managed-by': 'wrc' } },
    spec: { contextId, mcpServers: [...mcpServers] },
  }
}

describe('planContextReplacement invariants', () => {
  it('shared Context: the merged allowlist never loses a server that was live', () => {
    fc.assert(
      fc.property(serverList, serverList, (existing, desired) => {
        const plan = planContextReplacement(liveContext(existing), planArgs(true, desired))
        // A null plan is a skip, which by definition writes nothing and so
        // cannot shrink anything. Only a planned write can drop an entry.
        if (plan === null) return
        for (const name of existing) expect(plan.mergedServers).toContain(name)
        for (const name of desired) expect(plan.mergedServers).toContain(name)
      })
    )
  })

  it('never plans a body containing duplicates, on either path', () => {
    fc.assert(
      fc.property(fc.boolean(), serverList, serverList, (explicit, existing, desired) => {
        const plan = planContextReplacement(liveContext(existing), planArgs(explicit, desired))
        if (plan === null) return
        expect(new Set(plan.mergedServers).size).toBe(plan.mergedServers.length)
      })
    )
  })

  it('converges: applying a plan makes the next pass a skip', () => {
    fc.assert(
      fc.property(fc.boolean(), serverList, serverList, (explicit, existing, desired) => {
        const args = planArgs(explicit, desired)
        const first = planContextReplacement(liveContext(existing), args)
        if (first === null) return

        // Apply the plan the way replaceExistingContext does, then re-plan
        // against the resulting object. A planner that cannot reach a fixed
        // point writes on every pass forever.
        const applied = {
          metadata: {
            resourceVersion: '2',
            labels: { ...first.existingLabels, ...first.authoredLabels },
            ...(first.nextOwnerReferences.length > 0
              ? { ownerReferences: first.nextOwnerReferences }
              : {}),
          },
          spec: { contextId: first.nextContextId, mcpServers: first.mergedServers },
        }
        expect(planContextReplacement(applied, args)).toBeNull()
      })
    )
  })

  it('a private Context is authoritative: the merged set is exactly what was asked for', () => {
    // The counterpart to no-shrink. `wf-*` is single-writer, so removing a
    // server from the recipe MUST remove it from the Context — a property that
    // would be destroyed by "fixing" the shared no-shrink rule globally.
    fc.assert(
      fc.property(serverList, serverList, (existing, desired) => {
        const plan = planContextReplacement(liveContext(existing), planArgs(false, desired))
        if (plan === null) return
        expect([...plan.mergedServers].sort()).toEqual([...new Set(desired)].sort())
      })
    )
  })

  it('a non-empty legacy contextId is preserved verbatim; an empty one is repaired once', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(''), fc.constantFrom('legacy-id', 'context1', 'other-id')),
        serverList,
        (contextId, desired) => {
          const args = planArgs(true, desired)
          const plan = planContextReplacement(liveContext(desired, contextId), args)
          if (plan === null) return
          expect(plan.nextContextId).toBe(contextId === '' ? 'context1' : contextId)
        }
      )
    )
  })
})
