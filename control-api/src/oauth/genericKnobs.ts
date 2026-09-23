import { z } from 'zod'
import type { GenericClientRouting } from './callback.js'

/**
 * Install-side wire knobs for the `source:'generic'` carril (S3-B4 / DEC-28).
 *
 * This is the SINGLE install-side source of truth for the 11 generic knobs plus the
 * fail-closed `supportsRefresh` flag — a 1:1 mirror of the CRD generic fields
 * (`mcpserver.yaml` generic block) and of the runtime routing shape
 * (`GenericClientRouting` = `GenericAdapterConfig` + `supportsRefresh`). It is NOT a
 * decision module (DEC-28 / D3): it is pure FORM — each field independently selects
 * one fixed wire behaviour, with no precedence, merge or ordering resolution.
 *
 * No defaults: fidelity to the CRD (which has none — a CRD default would void the
 * GENERIC-REQ presence check) and to `extractGenericRouting`, which reads the
 * booleans with `=== true` (absent ⇒ false). The install path writes the 10
 * GENERIC-REQ knobs explicitly; the wizard is what fills defaults, never the server.
 */
export const GenericOAuthKnobsSchema = z
  .object({
    authorizationEndpoint: z.string().min(1).max(2048),
    tokenEndpoint: z.string().min(1).max(2048),
    refreshEndpoint: z.string().min(1).max(2048).optional(),
    resource: z.string().min(1).max(2048).optional(),
    tokenRequestFormat: z.enum(['form', 'json']),
    tokenAuthMethod: z.enum(['body', 'basic']),
    scopeSeparator: z.enum(['space', 'comma']),
    sendScope: z.boolean(),
    usePkce: z.boolean(),
    includeResponseType: z.boolean(),
    supportsRefresh: z.boolean(),
    extraAuthorizeParams: z
      .record(z.string(), z.string().max(1024))
      .refine(o => Object.keys(o).length <= 16, { message: 'at most 16 extra authorize params' })
      .optional(),
  })
  .strict()

export type GenericOAuthKnobs = z.infer<typeof GenericOAuthKnobsSchema>

// Compile-time lockstep with the runtime routing shape (there is no single runtime
// source to derive from — the runtime keeps its own interface for the exchange/
// refresh path). If a knob is added, removed, renamed or re-typed on either side,
// this equality fails to compile, so install-side and runtime-side can never drift.
type Expect<T extends true> = T
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export type _KnobsMatchRuntime = Expect<Equal<GenericOAuthKnobs, GenericClientRouting>>

/**
 * A catalog-supplied generic suggestion (E-19.6): every knob optional — the catalog
 * SUGGESTS, the admin confirms, control-api arbitrates (S-4). Validated when the
 * catalog entry is parsed; the install saga never reads it to build `spec.oauth`.
 */
export const GenericConfigSuggestionSchema = GenericOAuthKnobsSchema.partial()
export type GenericConfigSuggestion = z.infer<typeof GenericConfigSuggestionSchema>
