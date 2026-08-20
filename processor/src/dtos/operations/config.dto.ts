import { Static, Type } from '@sinclair/typebox'

/**
 * Shared by /config and /operations/config - one schema, not two hand-mirrored copies.
 * Mirrored in enabler/src/payment-enabler/payment-enabler-briqpay.ts BriqpayConfigResponse.
 * No clientKey/environment: Briqpay's embed is a pre-built HTML snippet, not an SDK bootstrap.
 */
export const ConfigResponseSchema = Type.Object({
  snippet: Type.String(),
  briqpaySessionId: Type.String(),
})

export type ConfigResponseSchemaDTO = Static<typeof ConfigResponseSchema>
