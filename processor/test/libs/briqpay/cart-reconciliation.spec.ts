import { describe, expect, it } from '@jest/globals'
import { Cart } from '@commercetools/connect-payments-sdk'
import { planCartReconciliation } from '../../../src/libs/briqpay/cart-reconciliation'
import {
  CartItem,
  ITEM_PRODUCT_TYPE,
  MediumBriqpayResponse,
  TRANSACTION_STATUS,
} from '../../../src/services/types/briqpay-payment.type'

const eur = (centAmount: number) => ({
  type: 'centPrecision' as const,
  currencyCode: 'EUR',
  centAmount,
  fractionDigits: 2,
})

const CHAIR_UNIT_GROSS = 29900
const SHIPPING_GROSS = 10000

const lineItem = (opts: { id: string; sku: string; quantity: number; unitGross: number }) => ({
  id: opts.id,
  productId: `product-${opts.id}`,
  name: { 'de-DE': 'Traditioneller Sessel' },
  productType: { typeId: 'product-type' as const, id: 'product-type-1' },
  price: { id: `price-${opts.id}`, value: eur(opts.unitGross) },
  quantity: opts.quantity,
  totalPrice: eur(opts.unitGross * opts.quantity),
  discountedPricePerQuantity: [],
  taxedPricePortions: [],
  state: [],
  perMethodTaxRate: [],
  priceMode: 'Platform' as const,
  lineItemMode: 'Standard' as const,
  taxRate: { name: 'VAT', amount: 0.19, includedInPrice: true, country: 'DE' },
  variant: { id: 1, sku: opts.sku },
})

// Modelled on the replicated drift: paid for one armchair, cart grew to three afterwards.
const buildCart = (overrides: Partial<Cart> = {}): Cart => {
  const lineItems = overrides.lineItems ?? [
    lineItem({ id: 'line-1', sku: 'TARM-034', quantity: 3, unitGross: CHAIR_UNIT_GROSS }),
  ]
  const lineGross = lineItems.reduce((total, item) => total + item.price.value.centAmount * item.quantity, 0)

  const cart: Cart = {
    id: 'cart-1',
    version: 38,
    lineItems,
    customLineItems: [],
    totalPrice: eur(lineGross + SHIPPING_GROSS),
    taxedPrice: {
      totalNet: eur(Math.round((lineGross + SHIPPING_GROSS) / 1.19)),
      totalGross: eur(lineGross + SHIPPING_GROSS),
      taxPortions: [],
    },
    cartState: 'Active',
    origin: 'Customer',
    taxMode: 'Platform',
    taxRoundingMode: 'HalfUp',
    taxCalculationMode: 'LineItemLevel',
    priceRoundingMode: 'HalfEven',
    shipping: [],
    discountCodes: [],
    directDiscounts: [],
    refusedGifts: [],
    itemShippingAddresses: [],
    inventoryMode: 'None',
    shippingMode: 'Single',
    shippingInfo: {
      shippingMethodName: 'Standard Delivery',
      price: eur(SHIPPING_GROSS),
      shippingRate: { price: eur(SHIPPING_GROSS), tiers: [] },
      taxedPrice: {
        totalNet: eur(8403),
        totalGross: eur(SHIPPING_GROSS),
        taxPortions: [],
      },
      deliveries: [],
      shippingMethodState: 'MatchesCart',
    },
    createdAt: '2026-09-15T11:29:30.713Z',
    lastModifiedAt: '2026-09-15T11:30:11.993Z',
    ...overrides,
  }

  return cart
}

const paidChair: CartItem = {
  productType: ITEM_PRODUCT_TYPE.PHYSICAL,
  reference: 'TARM-034',
  name: 'Traditioneller Sessel',
  quantity: 1,
  quantityUnit: 'pc',
  unitPrice: 25126,
  taxRate: 1900,
  totalAmount: CHAIR_UNIT_GROSS,
  totalVatAmount: 4774,
  unitPriceIncVat: CHAIR_UNIT_GROSS,
}

const paidShipping: CartItem = {
  productType: ITEM_PRODUCT_TYPE.SHIPPING_FEE,
  reference: 'shippingfee',
  name: 'Shipping fee',
  quantity: 1,
  quantityUnit: 'pc',
  unitPrice: 8403,
  taxRate: 1900,
  totalAmount: SHIPPING_GROSS,
  totalVatAmount: 1597,
  unitPriceIncVat: SHIPPING_GROSS,
}

const buildSession = (cart: CartItem[], amountIncVat: number): MediumBriqpayResponse => {
  const session: MediumBriqpayResponse = {
    sessionId: 'e568319b-d2d9-4c1f-9011-3f703abf8098',
    htmlSnippet: '',
    data: { order: { amountIncVat, amountExVat: 33529, currency: 'EUR', cart } },
  }

  return session
}

const paidOneChair = () => buildSession([paidChair, paidShipping], CHAIR_UNIT_GROSS + SHIPPING_GROSS)

describe('planCartReconciliation', () => {
  it('lowers the quantity back to what was paid for', () => {
    const result = planCartReconciliation(buildCart(), paidOneChair())

    expect(result).toEqual({
      status: 'plan',
      actions: [{ action: 'changeLineItemQuantity', lineItemId: 'line-1', quantity: 1 }],
      predictedGrossCentAmount: 39900,
    })
  })

  it('drops a line the buyer added after paying', () => {
    const cart = buildCart({
      lineItems: [
        lineItem({ id: 'line-1', sku: 'TARM-034', quantity: 1, unitGross: CHAIR_UNIT_GROSS }),
        lineItem({ id: 'line-2', sku: 'LAMP-001', quantity: 2, unitGross: 5000 }),
      ],
    })

    const result = planCartReconciliation(cart, paidOneChair())

    expect(result).toEqual({
      status: 'plan',
      actions: [{ action: 'changeLineItemQuantity', lineItemId: 'line-2', quantity: 0 }],
      predictedGrossCentAmount: 39900,
    })
  })

  it('reads the paid lines from the approved transaction when it carries them', () => {
    const session = paidOneChair()
    session.data = {
      ...session.data,
      order: { amountIncVat: 39900, amountExVat: 33529, currency: 'EUR', cart: [] },
      transactions: [
        {
          transactionId: 'tx-1',
          status: TRANSACTION_STATUS.APPROVED,
          amountIncVat: 39900,
          currency: 'EUR',
          cart: [paidChair, paidShipping],
        },
      ],
    }

    const result = planCartReconciliation(buildCart(), session)

    expect(result).toMatchObject({ status: 'plan', predictedGrossCentAmount: 39900 })
  })

  // Everything below must leave the cart alone: a half-corrected cart is worse than a flagged one.
  it.each([
    [
      'the cart already matches',
      buildCart({ lineItems: [lineItem({ id: 'line-1', sku: 'TARM-034', quantity: 1, unitGross: CHAIR_UNIT_GROSS })] }),
    ],
    ['the cart is already ordered', buildCart({ cartState: 'Ordered' })],
    [
      'a discount code is applied',
      buildCart({ discountCodes: [{ discountCode: { typeId: 'discount-code', id: 'dc-1' }, state: 'MatchesCart' }] }),
    ],
    [
      'a direct discount is applied',
      buildCart({
        directDiscounts: [
          { id: 'dd-1', value: { type: 'absolute', money: [] }, target: { type: 'lineItems', predicate: '1=1' } },
        ],
      }),
    ],
    ['taxes are external', buildCart({ taxMode: 'External' })],
    ['shipping is split', buildCart({ shippingMode: 'Multiple' })],
  ])('refuses when %s', (_case, cart) => {
    expect(planCartReconciliation(cart, paidOneChair())).toMatchObject({ status: 'refused' })
  })

  it('refuses a paid line that is no longer in the cart', () => {
    const cart = buildCart({ lineItems: [lineItem({ id: 'line-2', sku: 'LAMP-001', quantity: 1, unitGross: 39900 })] })

    expect(planCartReconciliation(cart, paidOneChair())).toMatchObject({
      status: 'refused',
      reason: 'a paid line is no longer in the cart',
    })
  })

  it('refuses when two line items share one reference', () => {
    const cart = buildCart({
      lineItems: [
        lineItem({ id: 'line-1', sku: 'TARM-034', quantity: 2, unitGross: CHAIR_UNIT_GROSS }),
        lineItem({ id: 'line-2', sku: 'TARM-034', quantity: 1, unitGross: CHAIR_UNIT_GROSS }),
      ],
    })

    expect(planCartReconciliation(cart, paidOneChair())).toMatchObject({
      status: 'refused',
      reason: 'two cart line items share one reference',
    })
  })

  // The guard that makes this safe: unit price moved since payment, so the quantities the
  // session names would not add up to what was authorized.
  it('refuses when the reconciled cart would not total the paid amount', () => {
    const cart = buildCart({
      lineItems: [lineItem({ id: 'line-1', sku: 'TARM-034', quantity: 3, unitGross: 31000 })],
    })

    expect(planCartReconciliation(cart, paidOneChair())).toMatchObject({
      status: 'refused',
      reason: 'reconciled cart would total 41000, paid was 39900',
    })
  })

  // The hole a totals-only drift check leaves open: swap a paid item for an equally priced one
  // and the cart total never moves, but the buyer paid for something else.
  it('catches a swap for an equally priced item, where the cart total is unchanged', () => {
    const cart = buildCart({
      lineItems: [
        lineItem({ id: 'line-1', sku: 'GLOVE-A', quantity: 1, unitGross: 1000 }),
        lineItem({ id: 'line-2', sku: 'GLOVE-B', quantity: 1, unitGross: 1000 }),
      ],
    })
    const paidTwoGloves = buildSession(
      [{ ...paidChair, reference: 'GLOVE-A', quantity: 2, unitPriceIncVat: 1000, totalAmount: 2000 }, paidShipping],
      2000 + SHIPPING_GROSS,
    )

    expect(cart.taxedPrice?.totalGross.centAmount).toBe(2000 + SHIPPING_GROSS)
    expect(planCartReconciliation(cart, paidTwoGloves)).toEqual({
      status: 'plan',
      actions: [
        { action: 'changeLineItemQuantity', lineItemId: 'line-1', quantity: 2 },
        { action: 'changeLineItemQuantity', lineItemId: 'line-2', quantity: 0 },
      ],
      predictedGrossCentAmount: 12000,
    })
  })

  it('refuses when the lines match but the total does not', () => {
    const cart = buildCart({
      lineItems: [lineItem({ id: 'line-1', sku: 'TARM-034', quantity: 1, unitGross: CHAIR_UNIT_GROSS })],
    })

    expect(planCartReconciliation(cart, buildSession([paidChair, paidShipping], 45000))).toMatchObject({
      status: 'refused',
      reason: 'cart holds the paid lines but totals 39900, paid was 45000',
    })
  })

  it('refuses when the session carries a line with no line-item equivalent', () => {
    const discountLine: CartItem = {
      ...paidChair,
      productType: ITEM_PRODUCT_TYPE.DISCOUNT,
      reference: 'TARM-034-discount',
    }

    expect(
      planCartReconciliation(buildCart(), buildSession([paidChair, discountLine, paidShipping], 39900)),
    ).toMatchObject({
      status: 'refused',
      reason: 'session carries lines with no line-item equivalent',
    })
  })
})
