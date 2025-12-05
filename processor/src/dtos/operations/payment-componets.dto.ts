import { Static, Type } from '@sinclair/typebox'
import { PaymentMethodType } from '../briqpay-payment.dto'

export const SupportedPaymentDropinsData = Type.Object({
  type: Type.String(Type.Enum(PaymentMethodType)),
})

export const SupportedPaymentComponentsData = Type.Object({
  type: Type.String(Type.Enum(PaymentMethodType)),
  subtypes: Type.Optional(Type.Array(Type.String())),
})

/**
 * Supported payment components schema.
 *
 * Example:
 * {
 *   "dropins": [
 *     {
 *       "type": "embedded"
 *     }
 *   ],
 *   "components": [
 *     {
 *       "type": "card"
 *     },
 *     {
 *       "type": "applepay"
 *     }
 *   ]
 * }
 */
export const SupportedPaymentComponentsSchema = Type.Object({
  dropins: Type.Array(SupportedPaymentDropinsData),
  components: Type.Array(SupportedPaymentComponentsData),
})

export type SupportedPaymentComponentsSchemaDTO = Static<typeof SupportedPaymentComponentsSchema>
