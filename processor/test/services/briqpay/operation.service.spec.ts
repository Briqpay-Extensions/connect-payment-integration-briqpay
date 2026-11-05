import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import { ErrorInvalidOperation } from '@commercetools/connect-payments-sdk'
import { BriqpayOperationService } from '../../../src/services/briqpay/operation.service'
import { mockGetCartResult, withCurrency } from '../../utils/mock-cart-data'
import Briqpay from '../../../src/libs/briqpay/BriqpayService'
import type {
  Cart,
  CommercetoolsCartService,
  CommercetoolsPaymentService,
  Payment,
} from '@commercetools/connect-payments-sdk'
import { briqpaySessionIdFieldName } from '../../../src/custom-types/custom-types'
import { appLogger } from '../../../src/payment-sdk'
import {
  BriqpayCapture,
  BriqpayRefund,
  BriqpayTransaction,
  ITEM_PRODUCT_TYPE,
  ORDER_STATUS,
  TRANSACTION_STATUS,
} from '../../../src/services/types/briqpay-payment.type'

jest.mock('../../../src/libs/commercetools/api-root')

jest.mock('../../../src/payment-sdk', () => ({
  appLogger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}))

jest.mock('../../../src/libs/fastify/context/context', () => ({
  getCartIdFromContext: () => 'cart-drift-1',
  getPaymentInterfaceFromContext: () => 'Briqpay',
  getCheckoutTransactionItemIdFromContext: () => 'checkout-tx-item-1',
  getFutureOrderNumberFromContext: () => undefined,
}))

jest.mock('../../../src/libs/briqpay/BriqpayService', () => {
  const actual = jest.requireActual('../../../src/libs/briqpay/BriqpayService') as Record<string, unknown>
  return {
    __esModule: true,
    ...actual,
    default: {
      createSession: jest.fn(),
      getSession: jest.fn(),
      updateSession: jest.fn(),
      capture: jest.fn(),
      refund: jest.fn(),
      makeDecision: jest.fn(),
      cancel: jest.fn(),
      healthCheck: jest.fn(),
    },
  }
})

// createPayment stages the fetched session onto the cart via the session-data service; mock it
// so the fire-and-forget staging is an assertable no-op instead of touching commercetools.
const mockIngestSessionDataToCart = jest.fn<(session: unknown, cartId: string) => Promise<void>>()
jest.mock('../../../src/services/briqpay/session-data.service', () => ({
  getBriqpaySessionDataService: () => ({ ingestSessionDataToCart: mockIngestSessionDataToCart }),
}))

const mockedBriqpay = jest.mocked(Briqpay)

// Pierce order 80114753: the payment was created before the shipping method landed, so the connector
// planned the pre-shipping total while the order was placed at the post-shipping one.
const PRE_SHIPPING_TOTAL = 14879
const POST_SHIPPING_TOTAL = 15718
const SESSION_ID = 'briqpay-session-drift-1'
const CAPTURE_ID = 'briqpay-capture-1'

// Carts carry taxedPrice in production, which is the branch getPaymentAmount and the guards read first.
const cartAtTotal = (centAmount: number): Cart =>
  ({
    ...mockGetCartResult(),
    id: 'cart-drift-1',
    custom: {
      type: { typeId: 'type', id: 'briqpay-type' },
      fields: { [briqpaySessionIdFieldName]: SESSION_ID },
    },
    totalPrice: { type: 'centPrecision', currencyCode: 'EUR', centAmount, fractionDigits: 2 },
    taxedPrice: {
      totalNet: {
        type: 'centPrecision',
        currencyCode: 'EUR',
        centAmount: Math.round(centAmount / 1.25),
        fractionDigits: 2,
      },
      totalGross: { type: 'centPrecision', currencyCode: 'EUR', centAmount, fractionDigits: 2 },
      taxPortions: [],
    },
  }) as unknown as Cart

// Mirrors the SDK: cart total inc. tax, less anything already paid.
const paymentAmountFor = (cart: Cart, alreadyPaid = 0) => ({
  centAmount: (cart.taxedPrice?.totalGross?.centAmount ?? cart.totalPrice.centAmount) - alreadyPaid,
  currencyCode: cart.totalPrice.currencyCode,
  fractionDigits: cart.totalPrice.fractionDigits,
})

describe('BriqpayOperationService amount reconciliation', () => {
  let operationService: BriqpayOperationService

  const mockCtCartService = {
    getCartByPaymentId: jest.fn(),
    getCart: jest.fn(),
    getPaymentAmount: jest.fn(),
    addPayment: jest.fn(),
  } as unknown as CommercetoolsCartService

  const mockCtPaymentService = {
    updatePayment: jest.fn(),
    getPayment: jest.fn(),
    createPayment: jest.fn(),
    findPaymentsByInterfaceId: jest.fn(),
    hasTransactionInState: jest.fn(),
  } as unknown as CommercetoolsPaymentService

  beforeEach(() => {
    jest.clearAllMocks()
    operationService = new BriqpayOperationService(mockCtCartService, mockCtPaymentService)

    jest.mocked(mockCtPaymentService.updatePayment).mockResolvedValue({ id: 'payment-drift-1' } as never)
    jest.mocked(mockCtCartService.addPayment).mockResolvedValue({} as never)
    jest.mocked(mockCtPaymentService.findPaymentsByInterfaceId).mockResolvedValue([])

    mockedBriqpay.capture.mockResolvedValue({ captureId: CAPTURE_ID, status: 'approved' } as never)
    mockedBriqpay.refund.mockResolvedValue({ refundId: 'briqpay-refund-1', status: 'approved' } as never)
    // createPayment/handleTransaction derive the authorization state from the session; these amount
    // tests don't exercise status, so any resolvable session suffices (no orderStatus -> Pending).
    mockedBriqpay.getSession.mockResolvedValue({ sessionId: SESSION_ID } as never)
    mockIngestSessionDataToCart.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  /**
   * Drives the connector's own createPayment so amountPlanned is the value the connector computed, not
   * one this test invented.
   */
  const paymentPlannedOn = async (cart: Cart, alreadyPaid = 0): Promise<Payment> => {
    jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)
    jest.mocked(mockCtCartService.getPaymentAmount).mockResolvedValue(paymentAmountFor(cart, alreadyPaid))

    let stampedAmountPlanned: Payment['amountPlanned'] | undefined
    jest.mocked(mockCtPaymentService.createPayment).mockImplementation(async (draft) => {
      stampedAmountPlanned = draft.amountPlanned as Payment['amountPlanned']
      return { id: 'payment-drift-1', amountPlanned: draft.amountPlanned, transactions: [] } as never
    })

    await operationService.createPayment({
      data: { paymentMethod: { type: 'briqpay' }, paymentOutcome: 'pending' },
    } as never)

    if (!stampedAmountPlanned) {
      throw new Error('connector did not create a payment')
    }

    return {
      id: 'payment-drift-1',
      version: 1,
      interfaceId: SESSION_ID,
      amountPlanned: stampedAmountPlanned,
      paymentMethodInfo: { paymentInterface: 'Briqpay' },
      transactions: [
        {
          id: 'auth-1',
          type: 'Authorization',
          interactionId: SESSION_ID,
          state: 'Success',
          amount: stampedAmountPlanned,
        },
      ],
      interfaceInteractions: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      lastModifiedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as Payment
  }

  const chargeWrittenByCapture = (centAmount: number): Payment['transactions'] =>
    [
      {
        id: 'charge-1',
        type: 'Charge',
        interactionId: CAPTURE_ID,
        state: 'Success',
        amount: { type: 'centPrecision', centAmount, currencyCode: 'EUR', fractionDigits: 2 },
      },
    ] as unknown as Payment['transactions']

  // A capture as GET session returns it: amounts plus the lines Briqpay validates a refund against.
  const captureOf = (amountIncVat: number, overrides: Partial<BriqpayCapture> = {}): BriqpayCapture => ({
    captureId: CAPTURE_ID,
    status: TRANSACTION_STATUS.APPROVED,
    amountIncVat,
    amountExVat: Math.round(amountIncVat / 1.25),
    currency: 'EUR',
    cart: [
      {
        productType: ITEM_PRODUCT_TYPE.PHYSICAL,
        reference: 'PIA-350482',
        name: 'Raven Airborne Evo MX Helmet',
        quantity: 1,
        quantityUnit: 'pc',
        unitPrice: Math.round(amountIncVat / 1.25),
        unitPriceIncVat: amountIncVat,
        taxRate: 2500,
        totalAmount: amountIncVat,
        totalVatAmount: amountIncVat - Math.round(amountIncVat / 1.25),
      },
    ],
    ...overrides,
  })

  // orderStatus is a string: Briqpay also returns statuses the connector's enum does not list
  const sessionHolding = (
    captures: BriqpayCapture[],
    {
      orderStatus,
      refunds = [],
      transactions = [],
    }: { orderStatus?: string; refunds?: BriqpayRefund[]; transactions?: BriqpayTransaction[] } = {},
  ) => ({
    sessionId: SESSION_ID,
    data: { captures, refunds, transactions },
    moduleStatus: { payment: { orderStatus } },
  })

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

  const authorizationOf = (status: TRANSACTION_STATUS, autoCaptureEnabled: boolean): BriqpayTransaction => ({
    transactionId: `transaction-${status}`,
    status,
    amountIncVat: PRE_SHIPPING_TOTAL,
    currency: 'EUR',
    autoCaptureEnabled,
    createdAt: minutesAgo(1),
  })

  // A refusal that clears on its own once Briqpay moves on, so it must not page anyone.
  const expectRetryLater = async (reversal: Promise<unknown>, message: string) => {
    await expect(reversal).rejects.toMatchObject({ message, skipLog: true })
    expect(appLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID }),
      'Briqpay payment is not ready to reverse yet',
    )
    expect(appLogger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      'Cannot reverse the Briqpay payment automatically',
    )
  }

  // 24MX refunds the shipping fee on its own, so a capture carrying an earlier refund is routine.
  const refundOn = (parentCaptureId: string | undefined, status: TRANSACTION_STATUS): BriqpayRefund => ({
    refundId: 'earlier-refund',
    status,
    amountIncVat: 495,
    currency: 'EUR',
    parentCaptureId,
  })

  const recordedAmountFor = (type: string) =>
    jest
      .mocked(mockCtPaymentService.updatePayment)
      .mock.calls.map(([call]) => call)
      .find((call) => call.transaction?.type === type)?.transaction?.amount.centAmount

  describe('createPayment stages session data on the cart (best-effort)', () => {
    const createPaymentOn = async (cart: Cart): Promise<void> => {
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)
      jest.mocked(mockCtCartService.getPaymentAmount).mockResolvedValue(paymentAmountFor(cart))
      jest
        .mocked(mockCtPaymentService.createPayment)
        .mockResolvedValue({ id: 'payment-drift-1', amountPlanned: paymentAmountFor(cart), transactions: [] } as never)

      await operationService.createPayment({
        data: { paymentMethod: { type: 'briqpay' }, paymentOutcome: 'pending' },
      } as never)
      // Staging is fire-and-forget; drain the microtask queue before asserting.
      await new Promise((resolve) => setImmediate(resolve))
    }

    test('reuses the fetched session to stage the custom-field data on the cart', async () => {
      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: SESSION_ID,
        data: { pspMetadata: { description: 'desc' } },
      } as never)

      await createPaymentOn(cartAtTotal(POST_SHIPPING_TOTAL))

      expect(mockIngestSessionDataToCart).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION_ID }),
        'cart-drift-1',
      )
    })

    test('a staging failure never fails the payment', async () => {
      mockIngestSessionDataToCart.mockRejectedValue(new Error('CT down'))

      const cart = cartAtTotal(POST_SHIPPING_TOTAL)
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)
      jest.mocked(mockCtCartService.getPaymentAmount).mockResolvedValue(paymentAmountFor(cart))
      jest
        .mocked(mockCtPaymentService.createPayment)
        .mockResolvedValue({ id: 'payment-drift-1', amountPlanned: paymentAmountFor(cart), transactions: [] } as never)

      await expect(
        operationService.createPayment({
          data: { paymentMethod: { type: 'briqpay' }, paymentOutcome: 'pending' },
        } as never),
      ).resolves.toEqual({ paymentReference: 'payment-drift-1' })
      await new Promise((resolve) => setImmediate(resolve))
    })
  })

  describe('createPayment writes the PSP method info on the payment', () => {
    const createPaymentOn = async (cart: Cart): Promise<void> => {
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)
      jest.mocked(mockCtCartService.getPaymentAmount).mockResolvedValue(paymentAmountFor(cart))
      jest
        .mocked(mockCtPaymentService.createPayment)
        .mockResolvedValue({ id: 'payment-drift-1', amountPlanned: paymentAmountFor(cart), transactions: [] } as never)

      await operationService.createPayment({
        data: { paymentMethod: { type: 'briqpay' }, paymentOutcome: 'pending' },
      } as never)
    }

    test('passes pspIntegrationName as method and pspDisplayName as localized name', async () => {
      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: SESSION_ID,
        data: {
          transactions: [
            {
              transactionId: 'tx-1',
              status: 'approved',
              amountIncVat: POST_SHIPPING_TOTAL,
              currency: 'EUR',
              pspIntegrationName: 'mollie_cards',
              pspDisplayName: 'Mollie Cards',
            },
          ],
        },
      } as never)

      await createPaymentOn(cartAtTotal(POST_SHIPPING_TOTAL))

      expect(mockCtPaymentService.updatePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentMethodInfo: { method: 'mollie_cards', name: { en: 'Mollie Cards' } },
        }),
      )
    })

    test('writes neither method info nor the generic briqpay constant when the session has no transaction', async () => {
      mockedBriqpay.getSession.mockResolvedValue({ sessionId: SESSION_ID } as never)

      await createPaymentOn(cartAtTotal(POST_SHIPPING_TOTAL))

      const updateCall = jest.mocked(mockCtPaymentService.updatePayment).mock.calls[0][0]
      expect(updateCall).not.toHaveProperty('paymentMethodInfo')
      // The enabler's paymentMethod.type must no longer be copied into method.
      expect(updateCall).not.toHaveProperty('paymentMethod')
    })
  })

  // The cart grew after the payment was created, so amountPlanned is stale.
  test('captures the amount it records in commercetools', async () => {
    const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
    expect(payment.amountPlanned.centAmount).toBe(PRE_SHIPPING_TOTAL)

    jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(cartAtTotal(POST_SHIPPING_TOTAL))

    await operationService.capturePayment({
      payment,
      amount: { centAmount: POST_SHIPPING_TOTAL, currencyCode: 'EUR' },
    } as never)

    expect(mockedBriqpay.capture.mock.calls[0][1].centAmount).toBe(recordedAmountFor('Charge'))
  })

  describe('refundPayment refunds the capture its Charge points to', () => {
    const refundOf = (payment: Payment, centAmount: number, currencyCode = 'EUR') =>
      operationService.refundPayment({
        payment: {
          ...payment,
          transactions: [...payment.transactions, ...chargeWrittenByCapture(centAmount)],
        },
        amount: { centAmount, currencyCode },
      } as never)

    test('refunds the capture, not a since-drifted cart', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      const capture = captureOf(PRE_SHIPPING_TOTAL)
      mockedBriqpay.getSession.mockResolvedValue(sessionHolding([capture]) as never)
      // The shopper changed the cart after paying
      jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(cartAtTotal(POST_SHIPPING_TOTAL))

      await refundOf(payment, PRE_SHIPPING_TOTAL)

      expect(mockedBriqpay.refund).toHaveBeenCalledWith(SESSION_ID, capture)
      expect(mockCtCartService.getCartByPaymentId).not.toHaveBeenCalled()
      expect(recordedAmountFor('Refund')).toBe(PRE_SHIPPING_TOTAL)
    })

    test('refuses a refund in another currency than the capture', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(POST_SHIPPING_TOTAL))
      mockedBriqpay.getSession.mockResolvedValue(sessionHolding([captureOf(POST_SHIPPING_TOTAL)]) as never)

      await expect(refundOf(payment, POST_SHIPPING_TOTAL, 'SEK')).rejects.toThrow(
        'Only a full refund of the captured amount is supported',
      )
      expect(mockedBriqpay.refund).not.toHaveBeenCalled()
    })

    test('refuses when the Charge points to a capture the session does not hold', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(POST_SHIPPING_TOTAL))
      mockedBriqpay.getSession.mockResolvedValue(
        sessionHolding([captureOf(POST_SHIPPING_TOTAL, { captureId: 'another-capture' })]) as never,
      )

      await expect(refundOf(payment, POST_SHIPPING_TOTAL)).rejects.toThrow('Cannot find the Briqpay capture to refund')
      expect(mockedBriqpay.refund).not.toHaveBeenCalled()
    })

    // The refund webhook reaches commercetools a minute after Briqpay holds the refund.
    test('refuses a capture Briqpay already refunded before commercetools heard of it', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(POST_SHIPPING_TOTAL))
      mockedBriqpay.getSession.mockResolvedValue(
        sessionHolding([captureOf(POST_SHIPPING_TOTAL)], {
          refunds: [refundOn(CAPTURE_ID, TRANSACTION_STATUS.APPROVED)],
        }) as never,
      )

      await expect(refundOf(payment, POST_SHIPPING_TOTAL)).rejects.toThrow(
        'The Briqpay capture has already been refunded, in full or in part',
      )
      expect(mockedBriqpay.refund).not.toHaveBeenCalled()
    })

    test('refuses when the Charge carries no capture id', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(POST_SHIPPING_TOTAL))
      mockedBriqpay.getSession.mockResolvedValue(sessionHolding([captureOf(POST_SHIPPING_TOTAL)]) as never)
      const [charge] = chargeWrittenByCapture(POST_SHIPPING_TOTAL)

      await expect(
        operationService.refundPayment({
          payment: { ...payment, transactions: [...payment.transactions, { ...charge, interactionId: undefined }] },
          amount: { centAmount: POST_SHIPPING_TOTAL, currencyCode: 'EUR' },
        } as never),
      ).rejects.toThrow('Cannot find the Briqpay capture to refund')
      expect(mockedBriqpay.refund).not.toHaveBeenCalled()
    })

    // Briqpay holds ISK x100; commercetools holds whole kronor.
    test('refunds an ISK capture requested in whole kronor', async () => {
      const ISK_TOTAL = 12345
      const payment = await paymentPlannedOn(withCurrency(cartAtTotal(ISK_TOTAL), 'ISK', 0))
      const capture = captureOf(ISK_TOTAL * 100, { currency: 'ISK' })
      mockedBriqpay.getSession.mockResolvedValue(sessionHolding([capture]) as never)

      await operationService.refundPayment({
        payment: {
          ...payment,
          transactions: [
            ...payment.transactions,
            {
              id: 'charge-1',
              type: 'Charge',
              interactionId: CAPTURE_ID,
              state: 'Success',
              amount: { type: 'centPrecision', centAmount: ISK_TOTAL, currencyCode: 'ISK', fractionDigits: 0 },
            },
          ],
        },
        amount: { centAmount: ISK_TOTAL, currencyCode: 'ISK' },
      } as never)

      expect(mockedBriqpay.refund).toHaveBeenCalledWith(SESSION_ID, capture)
      expect(recordedAmountFor('Refund')).toBe(ISK_TOTAL)
    })
  })

  // No drift needed: getPaymentAmount subtracts what is already paid, the guard does not.
  test('captures the amount it records on a cart that already carries a paid amount', async () => {
    const ALREADY_PAID = 5000
    const cart = cartAtTotal(POST_SHIPPING_TOTAL)

    const payment = await paymentPlannedOn(cart, ALREADY_PAID)
    expect(payment.amountPlanned.centAmount).toBe(POST_SHIPPING_TOTAL - ALREADY_PAID)

    jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(cart)

    await operationService.capturePayment({
      payment,
      amount: { centAmount: POST_SHIPPING_TOTAL, currencyCode: 'EUR' },
    } as never)

    expect(mockedBriqpay.capture.mock.calls[0][1].centAmount).toBe(recordedAmountFor('Charge'))
  })

  // Briqpay holds ISK x100; the payment must be planned in whole kronor, with no false mismatch log.
  test('plans an undrifted ISK cart in ISK', async () => {
    const cart = withCurrency(cartAtTotal(PRE_SHIPPING_TOTAL), 'ISK', 0)
    mockedBriqpay.getSession.mockResolvedValue({
      sessionId: SESSION_ID,
      htmlSnippet: '',
      data: { order: { amountIncVat: PRE_SHIPPING_TOTAL * 100, amountExVat: 0, currency: 'ISK' } },
    } as never)

    const payment = await paymentPlannedOn(cart)

    expect(payment.amountPlanned.centAmount).toBe(PRE_SHIPPING_TOTAL)
    expect(appLogger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      'Amount mismatch between Briqpay and commercetools',
    )
  })

  // Both directions, so relaxing the guard to admit partials cannot also admit over-capturing.
  describe('amounts that are not the full cart total', () => {
    test('refuses a capture for less than the cart total', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(POST_SHIPPING_TOTAL))
      jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(cartAtTotal(POST_SHIPPING_TOTAL))

      await expect(
        operationService.capturePayment({
          payment,
          amount: { centAmount: POST_SHIPPING_TOTAL - 1, currencyCode: 'EUR' },
        } as never),
      ).rejects.toThrow('Commerce Tools does not support partial captures towards all payment providers')

      expect(mockedBriqpay.capture).not.toHaveBeenCalled()
    })

    test('refuses a capture for more than the cart total', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(POST_SHIPPING_TOTAL))
      jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(cartAtTotal(POST_SHIPPING_TOTAL))

      await expect(
        operationService.capturePayment({
          payment,
          amount: { centAmount: POST_SHIPPING_TOTAL + 1, currencyCode: 'EUR' },
        } as never),
      ).rejects.toThrow('Commerce Tools does not support partial captures towards all payment providers')

      expect(mockedBriqpay.capture).not.toHaveBeenCalled()
    })

    test('refuses a refund for less than the captured amount', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(POST_SHIPPING_TOTAL))
      mockedBriqpay.getSession.mockResolvedValue(sessionHolding([captureOf(POST_SHIPPING_TOTAL)]) as never)

      await expect(
        operationService.refundPayment({
          payment: {
            ...payment,
            transactions: [...payment.transactions, ...chargeWrittenByCapture(POST_SHIPPING_TOTAL)],
          },
          amount: { centAmount: POST_SHIPPING_TOTAL - 1, currencyCode: 'EUR' },
        } as never),
      ).rejects.toThrow('Only a full refund of the captured amount is supported')

      expect(mockedBriqpay.refund).not.toHaveBeenCalled()
    })
  })

  // The capture guard only ever compares the request against the CURRENT cart total - it never checks
  // back against amountPlanned (what was actually authorized on the Briqpay session). A cart that
  // drifts a second time after the payment was created can walk the requested amount arbitrarily far
  // from what was actually authorized, and this guard alone does not catch it. This documents that
  // gap rather than asserting a fix.
  describe('three amounts differing: authorized/planned vs cart-at-capture vs requested (documents a gap)', () => {
    const SECOND_DRIFT_TOTAL = 17650

    test('a capture matching a since-drifted cart total is not checked against amountPlanned', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      expect(payment.amountPlanned.centAmount).toBe(PRE_SHIPPING_TOTAL)

      // Cart drifted a second time, to a third distinct total, after the payment was authorized.
      jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(cartAtTotal(SECOND_DRIFT_TOTAL))

      await operationService.capturePayment({
        payment,
        amount: { centAmount: SECOND_DRIFT_TOTAL, currencyCode: 'EUR' },
      } as never)

      // Three genuinely different amounts were in play - what was authorized/planned
      // (PRE_SHIPPING_TOTAL), the cart total at capture time, and the requested capture amount -
      // yet the capture proceeded, because the guard only checks request.amount against the
      // current cart total and never looks at amountPlanned.
      expect(mockedBriqpay.capture).toHaveBeenCalled()
      expect(mockedBriqpay.capture.mock.calls[0][1].centAmount).toBe(SECOND_DRIFT_TOTAL)
      expect(mockedBriqpay.capture.mock.calls[0][1].centAmount).not.toBe(payment.amountPlanned.centAmount)
    })
  })

  describe('reversePayment asks Briqpay what to undo', () => {
    beforeEach(() => {
      // Mirrors the SDK: a transaction of that type in one of those states
      jest
        .mocked(mockCtPaymentService.hasTransactionInState)
        .mockImplementation(({ payment, transactionType, states }) =>
          payment.transactions.some((tx) => tx.type === transactionType && states.includes(tx.state)),
        )
      mockedBriqpay.cancel.mockResolvedValue({ status: 'approved' } as never)
    })

    const reverse = (payment: Payment) => operationService.reversePayment({ payment } as never)

    const withTransactions = (payment: Payment, transactions: Payment['transactions']): Payment => ({
      ...payment,
      transactions: [...payment.transactions, ...transactions],
    })

    test('refunds the capture when the cart drifted after payment', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      const capture = captureOf(PRE_SHIPPING_TOTAL)
      mockedBriqpay.getSession.mockResolvedValue(sessionHolding([capture]) as never)
      jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(cartAtTotal(POST_SHIPPING_TOTAL))

      await reverse(withTransactions(payment, chargeWrittenByCapture(PRE_SHIPPING_TOTAL)))

      expect(mockedBriqpay.refund).toHaveBeenCalledWith(SESSION_ID, capture)
      expect(mockedBriqpay.cancel).not.toHaveBeenCalled()
      expect(mockCtCartService.getCartByPaymentId).not.toHaveBeenCalled()
      expect(recordedAmountFor('Refund')).toBe(PRE_SHIPPING_TOTAL)
    })

    test('refunds when Briqpay captured before commercetools recorded the Charge', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      const capture = captureOf(PRE_SHIPPING_TOTAL)
      mockedBriqpay.getSession.mockResolvedValue(sessionHolding([capture]) as never)

      await reverse(payment)

      expect(mockedBriqpay.refund).toHaveBeenCalledWith(SESSION_ID, capture)
      expect(mockedBriqpay.cancel).not.toHaveBeenCalled()
    })

    test('cancels when Briqpay holds an approved order with no capture', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      mockedBriqpay.getSession.mockResolvedValue(
        sessionHolding([], { orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED }) as never,
      )

      await reverse(payment)

      expect(mockedBriqpay.cancel).toHaveBeenCalledWith(SESSION_ID)
      expect(mockedBriqpay.refund).not.toHaveBeenCalled()
    })

    // commercetools hears of Briqpay's approval and capture through webhooks, a minute or more later.
    describe('while commercetools still shows the authorization as pending', () => {
      const withAuthorizationPending = (payment: Payment): Payment => ({
        ...payment,
        transactions: payment.transactions.map((tx) =>
          tx.type === 'Authorization' ? { ...tx, state: 'Pending' as const } : tx,
        ),
      })

      test('cancels an order Briqpay already approved', async () => {
        const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
        mockedBriqpay.getSession.mockResolvedValue(
          sessionHolding([], { orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED }) as never,
        )

        await reverse(withAuthorizationPending(payment))

        expect(mockedBriqpay.cancel).toHaveBeenCalledWith(SESSION_ID)
      })

      // Fulfilment keys off Authorization Success; it must not first appear after the cancel.
      test('records the authorization as approved before the cancellation', async () => {
        const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
        mockedBriqpay.getSession.mockResolvedValue(
          sessionHolding([], { orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED }) as never,
        )
        jest.mocked(mockCtPaymentService.updatePayment).mockClear()

        await reverse(withAuthorizationPending(payment))

        const written = jest
          .mocked(mockCtPaymentService.updatePayment)
          .mock.calls.map(([call]) => [call.transaction?.type, call.transaction?.state])
        expect(written).toEqual([
          ['Authorization', 'Success'],
          ['CancelAuthorization', 'Success'],
        ])
      })

      test('refunds a capture Briqpay already approved', async () => {
        const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
        const capture = captureOf(PRE_SHIPPING_TOTAL)
        mockedBriqpay.getSession.mockResolvedValue(sessionHolding([capture]) as never)

        await reverse(withAuthorizationPending(payment))

        expect(mockedBriqpay.refund).toHaveBeenCalledWith(SESSION_ID, capture)
      })

      // createPayment records a session without an order status as a pending Authorization too.
      test.each([ORDER_STATUS.ORDER_PENDING, undefined])(
        'asks for a retry, and calls Briqpay for nothing, while Briqpay holds the order as %s',
        async (orderStatus) => {
          const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
          mockedBriqpay.getSession.mockResolvedValue(sessionHolding([], { orderStatus }) as never)
          jest.mocked(mockCtPaymentService.updatePayment).mockClear()

          await expectRetryLater(
            reverse(withAuthorizationPending(payment)),
            'Briqpay has not approved the payment yet; retry the reversal in a few minutes',
          )
          expect(mockedBriqpay.cancel).not.toHaveBeenCalled()
          expect(mockedBriqpay.refund).not.toHaveBeenCalled()
          // The Authorization stays Pending: Briqpay has not approved anything yet
          expect(mockCtPaymentService.updatePayment).not.toHaveBeenCalled()
        },
      )
    })

    // Briqpay captures such a payment about a minute after approval. Cancelling first leaves its capture job
    // retrying on a cancelled order, and a PSP that already took the money refuses the cancel.
    describe('when Briqpay captures the payment automatically', () => {
      test('asks for a retry instead of cancelling before the capture lands', async () => {
        const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
        mockedBriqpay.getSession.mockResolvedValue(
          sessionHolding([], {
            orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
            transactions: [authorizationOf(TRANSACTION_STATUS.APPROVED, true)],
          }) as never,
        )

        await expectRetryLater(
          reverse(payment),
          'Briqpay is capturing this payment automatically; retry the reversal in a few minutes',
        )
        expect(mockedBriqpay.cancel).not.toHaveBeenCalled()
        expect(mockedBriqpay.refund).not.toHaveBeenCalled()
      })

      // Briqpay retries a failed capture only every two hours; waiting past its first attempt would hold the
      // shopper's money for days while the reversal keeps asking for a retry.
      test.each([
        ['is overdue', minutesAgo(16)],
        ['carries no creation time', undefined],
      ])('cancels as before when the capture %s', async (_case, createdAt) => {
        const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
        mockedBriqpay.getSession.mockResolvedValue(
          sessionHolding([], {
            orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
            transactions: [{ ...authorizationOf(TRANSACTION_STATUS.APPROVED, true), createdAt }],
          }) as never,
        )

        await reverse(payment)

        expect(mockedBriqpay.cancel).toHaveBeenCalledWith(SESSION_ID)
      })

      test('refunds once the capture has landed', async () => {
        const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
        const capture = captureOf(PRE_SHIPPING_TOTAL)
        mockedBriqpay.getSession.mockResolvedValue(
          sessionHolding([capture], { transactions: [authorizationOf(TRANSACTION_STATUS.APPROVED, true)] }) as never,
        )

        await reverse(payment)

        expect(mockedBriqpay.refund).toHaveBeenCalledWith(SESSION_ID, capture)
      })

      test('still cancels a payment Briqpay leaves for the merchant to capture', async () => {
        const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
        mockedBriqpay.getSession.mockResolvedValue(
          sessionHolding([], {
            orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
            transactions: [authorizationOf(TRANSACTION_STATUS.APPROVED, false)],
          }) as never,
        )

        await reverse(payment)

        expect(mockedBriqpay.cancel).toHaveBeenCalledWith(SESSION_ID)
      })

      // Only the approved authorization is the one Briqpay will capture.
      test('ignores auto-capture on an earlier rejected attempt', async () => {
        const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
        mockedBriqpay.getSession.mockResolvedValue(
          sessionHolding([], {
            orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
            transactions: [
              authorizationOf(TRANSACTION_STATUS.REJECTED, true),
              authorizationOf(TRANSACTION_STATUS.APPROVED, false),
            ],
          }) as never,
        )

        await reverse(payment)

        expect(mockedBriqpay.cancel).toHaveBeenCalledWith(SESSION_ID)
      })
    })

    // Briqpay reports an expired authorization as order_cancelled.
    test.each(['order_cancelled', 'order_cancel_pending', 'order_rejected'])(
      'does not cancel an order Briqpay holds as %s',
      async (orderStatus) => {
        const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
        mockedBriqpay.getSession.mockResolvedValue(sessionHolding([], { orderStatus }) as never)

        await expect(reverse(payment)).rejects.toThrow(`Cannot reverse a Briqpay order in status ${orderStatus}`)
        expect(mockedBriqpay.cancel).not.toHaveBeenCalled()
        expect(appLogger.error).toHaveBeenCalledWith(
          { sessionId: SESSION_ID, orderStatus },
          'Cannot reverse the Briqpay payment automatically',
        )
      },
    )

    test.each([TRANSACTION_STATUS.APPROVED, TRANSACTION_STATUS.PENDING])(
      'does not refund a capture that already carries a %s refund',
      async (status) => {
        const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
        mockedBriqpay.getSession.mockResolvedValue(
          sessionHolding([captureOf(PRE_SHIPPING_TOTAL)], { refunds: [refundOn(CAPTURE_ID, status)] }) as never,
        )

        await expect(reverse(payment)).rejects.toThrow(
          'The Briqpay capture has already been refunded, in full or in part',
        )
        expect(mockedBriqpay.refund).not.toHaveBeenCalled()
      },
    )

    // Briqpay counts a refund that names no capture against every capture.
    test('counts a refund that names no capture, as Briqpay does', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      mockedBriqpay.getSession.mockResolvedValue(
        sessionHolding([captureOf(PRE_SHIPPING_TOTAL)], {
          refunds: [refundOn(undefined, TRANSACTION_STATUS.APPROVED)],
        }) as never,
      )

      await expect(reverse(payment)).rejects.toThrow(
        'The Briqpay capture has already been refunded, in full or in part',
      )
      expect(mockedBriqpay.refund).not.toHaveBeenCalled()
    })

    test('refunds a capture whose earlier refund was rejected', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      const capture = captureOf(PRE_SHIPPING_TOTAL)
      mockedBriqpay.getSession.mockResolvedValue(
        sessionHolding([capture], { refunds: [refundOn(CAPTURE_ID, TRANSACTION_STATUS.REJECTED)] }) as never,
      )

      await reverse(payment)

      expect(mockedBriqpay.refund).toHaveBeenCalledWith(SESSION_ID, capture)
    })

    test('refunds a capture when the only refund belongs to another capture', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      const capture = captureOf(PRE_SHIPPING_TOTAL)
      mockedBriqpay.getSession.mockResolvedValue(
        sessionHolding(
          [captureOf(PRE_SHIPPING_TOTAL, { captureId: 'rejected', status: TRANSACTION_STATUS.REJECTED }), capture],
          { refunds: [refundOn('rejected', TRANSACTION_STATUS.APPROVED)] },
        ) as never,
      )

      await reverse(payment)

      expect(mockedBriqpay.refund).toHaveBeenCalledWith(SESSION_ID, capture)
    })

    // Briqpay refuses to cancel an order with any capture on it, whatever that capture's status.
    test('refuses, and says so in the logs, when every capture was rejected or cancelled', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      mockedBriqpay.getSession.mockResolvedValue(
        sessionHolding([
          captureOf(PRE_SHIPPING_TOTAL, { captureId: 'rejected', status: TRANSACTION_STATUS.REJECTED }),
          captureOf(PRE_SHIPPING_TOTAL, { captureId: 'cancelled', status: TRANSACTION_STATUS.CANCELLED }),
        ]) as never,
      )

      await expect(reverse(payment)).rejects.toThrow(
        'Cannot reverse a payment whose Briqpay captures were all rejected or cancelled',
      )

      expect(appLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION_ID }),
        'Cannot reverse the Briqpay payment automatically',
      )
      expect(mockedBriqpay.cancel).not.toHaveBeenCalled()
      expect(mockedBriqpay.refund).not.toHaveBeenCalled()
    })

    test('refunds the approved capture next to a rejected one', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      const capture = captureOf(PRE_SHIPPING_TOTAL)
      mockedBriqpay.getSession.mockResolvedValue(
        sessionHolding([
          captureOf(PRE_SHIPPING_TOTAL, { captureId: 'rejected', status: TRANSACTION_STATUS.REJECTED }),
          capture,
        ]) as never,
      )

      await reverse(payment)

      expect(mockedBriqpay.refund).toHaveBeenCalledWith(SESSION_ID, capture)
    })

    test('refuses a capture that is still pending, and says so in the logs', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      mockedBriqpay.getSession.mockResolvedValue(
        sessionHolding([captureOf(PRE_SHIPPING_TOTAL, { status: TRANSACTION_STATUS.PENDING })]) as never,
      )

      await expectRetryLater(
        reverse(payment),
        'Cannot reverse a payment whose Briqpay capture is still pending; retry the reversal in a few minutes',
      )
      expect(mockedBriqpay.refund).not.toHaveBeenCalled()
      expect(mockedBriqpay.cancel).not.toHaveBeenCalled()
    })

    test('refuses two captures rather than reversing only one', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      mockedBriqpay.getSession.mockResolvedValue(
        sessionHolding([captureOf(5000), captureOf(PRE_SHIPPING_TOTAL - 5000, { captureId: 'second' })]) as never,
      )

      await expect(reverse(payment)).rejects.toThrow('Cannot reverse a payment with more than one Briqpay capture')

      expect(mockedBriqpay.refund).not.toHaveBeenCalled()
      expect(mockedBriqpay.cancel).not.toHaveBeenCalled()
    })

    // Briqpay will not cancel an order with a capture on it, so the uncaptured rest stays authorized.
    test('refunds a partial capture and logs that the rest is still authorized', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      const capture = captureOf(5000)
      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: SESSION_ID,
        data: { captures: [capture], order: { amountIncVat: PRE_SHIPPING_TOTAL, currency: 'EUR' } },
      } as never)

      await reverse(payment)

      expect(mockedBriqpay.refund).toHaveBeenCalledWith(SESSION_ID, capture)
      expect(appLogger.error).toHaveBeenCalledWith(
        {
          sessionId: SESSION_ID,
          captureId: CAPTURE_ID,
          capturedAmountIncVat: 5000,
          authorizedAmountIncVat: PRE_SHIPPING_TOTAL,
        },
        'Reversed a partial Briqpay capture; the rest is still authorized',
      )
    })

    test('does not flag a capture of the full authorized amount', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      const capture = captureOf(PRE_SHIPPING_TOTAL)
      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: SESSION_ID,
        data: { captures: [capture], order: { amountIncVat: PRE_SHIPPING_TOTAL, currency: 'EUR' } },
      } as never)

      await reverse(payment)

      expect(mockedBriqpay.refund).toHaveBeenCalledWith(SESSION_ID, capture)
      expect(appLogger.error).not.toHaveBeenCalledWith(
        expect.anything(),
        'Reversed a partial Briqpay capture; the rest is still authorized',
      )
    })

    test('refuses as an invalid operation when the Authorization carries no Briqpay session id', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      const withoutSessionId: Payment = {
        ...payment,
        transactions: payment.transactions.map((tx) => ({ ...tx, interactionId: undefined })),
      }
      mockedBriqpay.getSession.mockClear()

      await expect(reverse(withoutSessionId)).rejects.toThrow(ErrorInvalidOperation)
      expect(mockedBriqpay.getSession).not.toHaveBeenCalled()
    })

    test('logs the refund without the shopper details Briqpay returns', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      mockedBriqpay.getSession.mockResolvedValue(sessionHolding([captureOf(PRE_SHIPPING_TOTAL)]) as never)
      mockedBriqpay.refund.mockResolvedValue({
        refundId: 'briqpay-refund-1',
        status: 'approved',
        email: 'shopper@example.com',
      } as never)

      await reverse(payment)

      expect(appLogger.info).toHaveBeenCalledWith(
        { sessionId: SESSION_ID, refundId: 'briqpay-refund-1', status: 'approved' },
        'Briqpay refund completed',
      )
    })

    // Briqpay holds ISK x100; the Refund is recorded in whole kronor.
    test('records an ISK refund in whole kronor', async () => {
      const ISK_TOTAL = 12345
      const payment = await paymentPlannedOn(withCurrency(cartAtTotal(ISK_TOTAL), 'ISK', 0))
      mockedBriqpay.getSession.mockResolvedValue(
        sessionHolding([captureOf(ISK_TOTAL * 100, { currency: 'ISK' })]) as never,
      )

      await reverse(payment)

      expect(recordedAmountFor('Refund')).toBe(ISK_TOTAL)
    })

    test('still refuses a payment that was already reversed', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      mockedBriqpay.getSession.mockResolvedValue(sessionHolding([captureOf(PRE_SHIPPING_TOTAL)]) as never)
      const refunded = [
        {
          id: 'refund-1',
          type: 'Refund',
          interactionId: 'briqpay-refund-1',
          state: 'Success',
          amount: { type: 'centPrecision', centAmount: PRE_SHIPPING_TOTAL, currencyCode: 'EUR', fractionDigits: 2 },
        },
      ] as unknown as Payment['transactions']

      await expect(reverse(withTransactions(payment, refunded))).rejects.toThrow(
        'There is no successful payment transaction to reverse.',
      )
      expect(mockedBriqpay.refund).not.toHaveBeenCalled()
      expect(mockedBriqpay.cancel).not.toHaveBeenCalled()
    })
  })
})
