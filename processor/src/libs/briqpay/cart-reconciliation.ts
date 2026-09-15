import { Cart } from '@commercetools/connect-payments-sdk'
import { CartUpdateAction } from '@commercetools/platform-sdk'
import {
  CartItem,
  ITEM_PRODUCT_TYPE,
  MediumBriqpayResponse,
  TRANSACTION_STATUS,
} from '../../services/types/briqpay-payment.type'
import { boundCartLineReference } from './cart-line-reference'
import { readBriqpaySessionAmounts } from './session-amounts'

type CartLineItem = Cart['lineItems'][number]

/** The everyday answer: the cart still holds exactly what was paid for, so there is nothing to do. */
export const UNDRIFTED = 'cart already matches the paid lines'

export type CartReconciliationResult =
  | { status: 'plan'; actions: CartUpdateAction[]; predictedGrossCentAmount: number }
  | { status: 'refused'; reason: string }

/** Session line types that map 1:1 onto a commercetools line item. */
const LINE_ITEM_TYPES: readonly string[] = [
  ITEM_PRODUCT_TYPE.PHYSICAL,
  ITEM_PRODUCT_TYPE.DIGITAL,
  ITEM_PRODUCT_TYPE.VIRTUAL,
]

/** Cart-level session lines: no line item of their own, but part of the order total. */
const CART_LEVEL_TYPES: readonly string[] = [ITEM_PRODUCT_TYPE.SHIPPING_FEE, ITEM_PRODUCT_TYPE.SHIPPING_LINE]

const refuse = (reason: string): CartReconciliationResult => {
  const refused: CartReconciliationResult = { status: 'refused', reason }

  return refused
}

/**
 * The reference the session was built with, rebuilt from the live line. Deterministic and
 * identical to what BriqpayService sent, so a paid line can be matched back to its line item.
 */
const lineItemReference = (item: CartLineItem): string => boundCartLineReference(item.variant?.sku ?? item.id)

/**
 * Everything that makes a cart total something other than "sum of unit gross times quantity,
 * plus shipping". Each one would let a quantity change move the total in a direction the paid
 * session cannot predict, so the planner refuses rather than guess.
 */
const findCartBlocker = (cart: Cart): string | undefined => {
  if (cart.cartState !== 'Active') {
    return `cart is ${cart.cartState}`
  }

  if (cart.taxMode !== 'Platform') {
    return `cart uses ${cart.taxMode} tax mode`
  }

  if (cart.shippingMode !== 'Single') {
    return `cart uses ${cart.shippingMode} shipping mode`
  }

  if (cart.discountCodes.length > 0 || cart.directDiscounts.length > 0) {
    return 'cart carries discount codes or direct discounts'
  }

  if (cart.customLineItems.length > 0) {
    return 'cart carries custom line items'
  }

  // A tiered rate can re-price itself when the cart shrinks, which the prediction below
  // computes from the current shipping total and would therefore get wrong.
  if ((cart.shippingInfo?.shippingRate.tiers.length ?? 0) > 0) {
    return 'cart uses a tiered shipping rate'
  }

  const discountedLine = cart.lineItems.find(
    (item) => item.discountedPricePerQuantity.length > 0 || item.price.discounted !== undefined,
  )
  if (discountedLine) {
    return 'cart has discounted line items'
  }

  // Net-priced lines gross up per line with rounding, so the total is not the plain
  // unit-times-quantity sum the prediction relies on.
  const netPricedLine = cart.lineItems.find((item) => item.taxRate?.includedInPrice !== true)
  if (netPricedLine) {
    return 'cart has line items whose price excludes tax'
  }

  return undefined
}

/**
 * The lines the buyer actually paid for. The approved transaction is the authority - it is what
 * the PSP holds money against - and the order cart is the fallback for a session whose
 * transaction carries no lines.
 */
export const readPaidLines = (session: MediumBriqpayResponse): CartItem[] | undefined => {
  const approved = session.data?.transactions?.find((transaction) => transaction.status === TRANSACTION_STATUS.APPROVED)
  const lines = approved?.cart?.length ? approved.cart : session.data?.order?.cart

  return lines?.length ? lines : undefined
}

/**
 * Paid quantity per line reference. Undefined when the session carries a line type that has no
 * line-item equivalent (discounts, surcharges, deposits, sales tax): those move the total on
 * their own, so a quantity-only plan cannot reproduce it.
 */
const buildTargetQuantities = (paidLines: CartItem[]): Map<string, number> | undefined => {
  const targets = new Map<string, number>()

  for (const line of paidLines) {
    if (CART_LEVEL_TYPES.includes(line.productType)) {
      continue
    }

    if (!LINE_ITEM_TYPES.includes(line.productType) || !('quantity' in line)) {
      return undefined
    }

    const reference = String(line.reference)
    targets.set(reference, (targets.get(reference) ?? 0) + line.quantity)
  }

  return targets
}

/** Line items by the reference they were sent as. Undefined when two lines share one. */
const indexLineItemsByReference = (cart: Cart): Map<string, CartLineItem> | undefined => {
  const byReference = new Map<string, CartLineItem>()

  for (const item of cart.lineItems) {
    const reference = lineItemReference(item)
    if (byReference.has(reference)) {
      return undefined
    }

    byReference.set(reference, item)
  }

  return byReference
}

/**
 * Plans the cart back to the lines the buyer paid for, so commercetools Checkout converts a cart
 * that matches the authorization instead of one the buyer changed afterwards.
 *
 * Quantity-only: it lowers or drops lines that grew past what was paid. A paid line that is no
 * longer in the cart would need re-adding at a price the session cannot vouch for, so that is
 * refused rather than guessed.
 *
 * The plan is only returned when the resulting gross - computed here, since commercetools offers
 * no dry run - equals the paid amount exactly. Anything else is a refusal, so the cart is never
 * left half-corrected.
 */
export const planCartReconciliation = (cart: Cart, session: MediumBriqpayResponse): CartReconciliationResult => {
  const sessionAmounts = readBriqpaySessionAmounts(session)
  const cartGross = cart.taxedPrice?.totalGross ?? cart.totalPrice

  if (typeof sessionAmounts.amountIncVat !== 'number' || sessionAmounts.currency !== cartGross.currencyCode) {
    return refuse('session carries no amount in the cart currency')
  }

  const paidLines = readPaidLines(session)
  if (!paidLines) {
    return refuse('session carries no cart lines')
  }

  const targets = buildTargetQuantities(paidLines)
  if (!targets) {
    return refuse('session carries lines with no line-item equivalent')
  }

  const byReference = indexLineItemsByReference(cart)
  if (!byReference) {
    return refuse('two cart line items share one reference')
  }

  const shippingGross = cart.shippingInfo?.taxedPrice?.totalGross.centAmount ?? 0
  const actions: CartUpdateAction[] = []
  let predictedGrossCentAmount = shippingGross

  for (const item of cart.lineItems) {
    const quantity = targets.get(lineItemReference(item)) ?? 0

    // Gross unit price, guarded below: quantity times unit is exactly what CT will recompute.
    predictedGrossCentAmount += item.price.value.centAmount * quantity

    if (quantity !== item.quantity) {
      actions.push({ action: 'changeLineItemQuantity', lineItemId: item.id, quantity })
    }
  }

  // Composition, not totals: a swap for an equally priced item leaves the cart total untouched
  // and still ships something nobody paid for. This runs before the blockers so an ordinary,
  // undrifted cart is answered here rather than flagged for a discount code it is allowed to have.
  if (actions.length === 0) {
    return cartGross.centAmount === sessionAmounts.amountIncVat
      ? refuse(UNDRIFTED)
      : refuse(`cart holds the paid lines but totals ${cartGross.centAmount}, paid was ${sessionAmounts.amountIncVat}`)
  }

  const missing = [...targets.keys()].find((reference) => !byReference.has(reference))
  if (missing) {
    return refuse('a paid line is no longer in the cart')
  }

  const blocker = findCartBlocker(cart)
  if (blocker) {
    return refuse(blocker)
  }

  if (predictedGrossCentAmount !== sessionAmounts.amountIncVat) {
    return refuse(`reconciled cart would total ${predictedGrossCentAmount}, paid was ${sessionAmounts.amountIncVat}`)
  }

  const plan: CartReconciliationResult = { status: 'plan', actions, predictedGrossCentAmount }

  return plan
}
