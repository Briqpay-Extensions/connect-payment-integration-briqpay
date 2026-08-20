import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import { BriqpayOperationService } from '../../../src/services/briqpay/operation.service'
import { mockGetCartResult } from '../../utils/mock-cart-data'
import Briqpay from '../../../src/libs/briqpay/BriqpayService'
import type {
  Cart,
  CommercetoolsCartService,
  CommercetoolsPaymentService,
  Payment,
} from '@commercetools/connect-payments-sdk'
import { briqpaySessionIdFieldName } from '../../../src/custom-types/custom-types'

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
  currencyCode: 'EUR',
  fractionDigits: 2,
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

  test('refunds the amount it records in commercetools', async () => {
    const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
    jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(cartAtTotal(POST_SHIPPING_TOTAL))

    await operationService.refundPayment({
      payment: {
        ...payment,
        transactions: [...payment.transactions, ...chargeWrittenByCapture(POST_SHIPPING_TOTAL)],
      },
      amount: { centAmount: POST_SHIPPING_TOTAL, currencyCode: 'EUR' },
    } as never)

    expect(mockedBriqpay.refund.mock.calls[0][1].centAmount).toBe(recordedAmountFor('Refund'))
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

    test('refuses a refund for less than the cart total', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(POST_SHIPPING_TOTAL))
      jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(cartAtTotal(POST_SHIPPING_TOTAL))

      await expect(
        operationService.refundPayment({
          payment: {
            ...payment,
            transactions: [...payment.transactions, ...chargeWrittenByCapture(POST_SHIPPING_TOTAL)],
          },
          amount: { centAmount: POST_SHIPPING_TOTAL - 1, currencyCode: 'EUR' },
        } as never),
      ).rejects.toThrow('Commerce Tools does not support partial refunds towards all payment providers')

      expect(mockedBriqpay.refund).not.toHaveBeenCalled()
    })
  })

  // The guard only ever compares the capture/refund request against the CURRENT cart total - it never
  // checks back against amountPlanned (what was actually authorized on the Briqpay session). A cart
  // that drifts a second time after the payment was created can walk the requested amount arbitrarily
  // far from what was actually authorized, and this guard alone does not catch it. This documents that
  // gap rather than asserting a fix - see DEV-3731 follow-up.
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

    test('a refund matching a since-drifted cart total is not checked against amountPlanned', async () => {
      const payment = await paymentPlannedOn(cartAtTotal(PRE_SHIPPING_TOTAL))
      expect(payment.amountPlanned.centAmount).toBe(PRE_SHIPPING_TOTAL)

      jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(cartAtTotal(SECOND_DRIFT_TOTAL))

      await operationService.refundPayment({
        payment: {
          ...payment,
          transactions: [...payment.transactions, ...chargeWrittenByCapture(SECOND_DRIFT_TOTAL)],
        },
        amount: { centAmount: SECOND_DRIFT_TOTAL, currencyCode: 'EUR' },
      } as never)

      expect(mockedBriqpay.refund).toHaveBeenCalled()
      expect(mockedBriqpay.refund.mock.calls[0][1].centAmount).toBe(SECOND_DRIFT_TOTAL)
      expect(mockedBriqpay.refund.mock.calls[0][1].centAmount).not.toBe(payment.amountPlanned.centAmount)
    })
  })
})
