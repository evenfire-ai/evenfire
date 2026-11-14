'use client'

import React from 'react'
import { formatHostRoles } from '@lib/llmModelAttention'
import type { ModelReferencesProps } from './types'

const NO_RECIPES: NonNullable<ModelReferencesProps['recipesAffected']> = []

/**
 * Renders the live Host/grant/recipe references to a (provider, model) pair.
 * Shared by the catalog-attention dialog and the 409 `model_in_use` impact
 * confirm so both surfaces list the references identically. Renders nothing
 * when there are no references.
 */
export function ModelReferences({
  hostsAffected,
  grantsAffected,
  recipesAffected = NO_RECIPES,
}: ModelReferencesProps) {
  if (hostsAffected.length === 0 && grantsAffected.length === 0 && recipesAffected.length === 0) {
    return null
  }

  return (
    <div className="cu-model-refs">
      {hostsAffected.length > 0 ? (
        <div>
          <span className="cu-model-refs__label">
            {hostsAffected.length} Host{hostsAffected.length === 1 ? '' : 's'}
          </span>
          <ul className="cu-model-refs__list">
            {hostsAffected.map(host => (
              <li key={`${host.namespace}/${host.name}`} className="cu-model-refs__item">
                <span>
                  {host.namespace}/{host.name}
                </span>
                {host.roles.length > 0 ? (
                  <span className="cu-model-refs__meta"> ({formatHostRoles(host.roles)})</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {grantsAffected.length > 0 ? (
        <div>
          <span className="cu-model-refs__label">
            {grantsAffected.length} grant{grantsAffected.length === 1 ? '' : 's'}
          </span>
          <ul className="cu-model-refs__list">
            {grantsAffected.map(grant => (
              <li key={grant.id} className="cu-model-refs__item">
                <span>
                  {grant.recipeNamespace}/{grant.recipeName}
                </span>
                <span className="cu-model-refs__meta"> · {grant.capabilityFamily}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {recipesAffected.length > 0 ? (
        <div>
          <span className="cu-model-refs__label">
            {recipesAffected.length} recipe{recipesAffected.length === 1 ? '' : 's'}
          </span>
          <ul className="cu-model-refs__list">
            {recipesAffected.map(recipe => (
              <li key={`${recipe.namespace}/${recipe.name}`} className="cu-model-refs__item">
                {recipe.namespace}/{recipe.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
