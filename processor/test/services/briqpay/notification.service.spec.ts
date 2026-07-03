import { describe, expect, test, jest, beforeEach } from '@jest/globals'

// Drive the private selector (the ingestSessionDataToOrder wrapper) in isolation: mock the
// order lookup and the session-data service so we assert ROUTING (order vs cart vs skip)
// without the webhook/HMAC/payment machinery.
const mockOrdersGet = jest.fn<() => Promise<{ body: { results: Array<{ id: string; version: number }> } }>>()

jest.mock('../../../src/libs/commercetools/api-root', () => ({
  apiRoot: {
    orders: () => ({ get: () => ({ execute: mockOrdersGet }) }),
  },
}))

const mockIngestToOrder = jest.fn<(sessionId: string, orderId: string) => Promise<void>>()
const mockIngestToCart = jest.fn<(sessionId: string, cartId: string) => Promise<void>>()

jest.mock('../../../src/services/briqpay/session-data.service', () => ({
  BriqpaySessionDataService: jest.fn().mockImplementation(() => ({
    ingestSessionDataToOrder: mockIngestToOrder,
    ingestSessionDataToCart: mockIngestToCart,
  })),
}))

jest.mock('../../../src/payment-sdk', () => ({
  appLogger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}))

jest.mock('../../../src/libs/briqpay/webhook-verification', () => ({
  isHmacVerificationEnabled: () => true,
  getWebhookSecret: () => 'test-secret',
  verifyBriqpayWebhook: () => ({ isValid: true }),
}))

import { BriqpayNotificationService } from '../../../src/services/briqpay/notification.service'
import { appLogger } from '../../../src/payment-sdk'
import {
  BRIQPAY_WEBHOOK_EVENT,
  BRIQPAY_WEBHOOK_STATUS,
  NotificationRequestSchemaDTO,
} from '../../../src/dtos/briqpay-payment.dto'

// The selector is a private arrow on the instance; reach it directly to test routing.
type SelectorAccess = {
  ingestSessionDataToOrder: (briqpaySessionId: string, paymentId: string, cartId?: string) => Promise<void>
}

describe('BriqpayNotificationService selector (order vs cart staging)', () => {
  let selector: SelectorAccess

  beforeEach(() => {
    jest.clearAllMocks()
    mockIngestToOrder.mockResolvedValue(undefined)
    mockIngestToCart.mockResolvedValue(undefined)

    const ctPaymentService = {} as never
    const operationService = {} as never
    const service = new BriqpayNotificationService(ctPaymentService, operationService)
    selector = service as unknown as SelectorAccess
  })

  test('order found -> writes the order, never stages the cart', async () => {
    mockOrdersGet.mockResolvedValue({ body: { results: [{ id: 'order-1', version: 3 }] } })

    await selector.ingestSessionDataToOrder('sess-1', 'pay-1', 'cart-1')

    expect(mockIngestToOrder).toHaveBeenCalledWith('sess-1', 'order-1')
    expect(mockIngestToCart).not.toHaveBeenCalled()
    expect(appLogger.error).not.toHaveBeenCalled()
  })

  test('no order yet + cartId present -> stages the cart for copy-on-creation', async () => {
    mockOrdersGet.mockResolvedValue({ body: { results: [] } })

    await selector.ingestSessionDataToOrder('sess-1', 'pay-1', 'cart-1')

    expect(mockIngestToCart).toHaveBeenCalledWith('sess-1', 'cart-1')
    expect(mockIngestToOrder).not.toHaveBeenCalled()
    expect(appLogger.error).not.toHaveBeenCalled()
  })

  test('no order and no cartId -> skips ingestion entirely', async () => {
    mockOrdersGet.mockResolvedValue({ body: { results: [] } })

    await selector.ingestSessionDataToOrder('sess-1', 'pay-1', undefined)

    expect(mockIngestToOrder).not.toHaveBeenCalled()
    expect(mockIngestToCart).not.toHaveBeenCalled()
    expect(appLogger.error).not.toHaveBeenCalled()
  })

  test('ingestion is best-effort: a thrown order lookup never propagates', async () => {
    mockOrdersGet.mockRejectedValue(new Error('CT down'))

    await expect(selector.ingestSessionDataToOrder('sess-1', 'pay-1', 'cart-1')).resolves.toBeUndefined()

    expect(mockIngestToOrder).not.toHaveBeenCalled()
    expect(mockIngestToCart).not.toHaveBeenCalled()
    expect(appLogger.error).toHaveBeenCalled()
  })
})

// Every verified webhook must trigger a best-effort full-session ingestion in the
// background, regardless of event type, handler outcome, or payload shape - the backfill
// guarantee for orders whose earlier ingestion attempts raced order creation or saw
// incomplete session data.
describe('BriqpayNotificationService ingest-on-every-webhook', () => {
  const mockFindPayments = jest.fn<() => Promise<Array<{ id: string; transactions: unknown[] }>>>()
  const mockUpdatePayment = jest.fn<() => Promise<unknown>>()
  const mockEnsurePayment = jest.fn<() => Promise<{ id: string; transactions: unknown[] } | null>>()

  let service: BriqpayNotificationService

  const notify = (data: NotificationRequestSchemaDTO) =>
    service.processNotification({ data, signatureHeader: 'sig', rawBody: '{}' })

  // Ingestion is fire-and-forget; drain its promise chain before asserting.
  const flushIngestion = () => new Promise((resolve) => setImmediate(resolve))

  beforeEach(() => {
    jest.clearAllMocks()
    mockIngestToOrder.mockResolvedValue(undefined)
    mockIngestToCart.mockResolvedValue(undefined)
    mockFindPayments.mockResolvedValue([{ id: 'pay-1', transactions: [] }])
    mockUpdatePayment.mockResolvedValue({})
    mockEnsurePayment.mockResolvedValue(null)
    mockOrdersGet.mockResolvedValue({ body: { results: [{ id: 'order-1', version: 1 }] } })

    const ctPaymentService = {
      findPaymentsByInterfaceId: mockFindPayments,
      updatePayment: mockUpdatePayment,
    } as never
    const operationService = { ensurePaymentForWebhook: mockEnsurePayment } as never
    service = new BriqpayNotificationService(ctPaymentService, operationService)
  })

  test('capture_status pending ingests (previously a non-ingesting event)', async () => {
    await notify({
      event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.PENDING,
      sessionId: 'sess-1',
      captureId: 'cap-1',
      capture: { captureId: 'cap-1', transactionId: 'tx-1', status: 'pending', amountIncVat: 100, currency: 'EUR' },
    })
    await flushIngestion()

    expect(mockIngestToOrder).toHaveBeenCalledWith('sess-1', 'order-1')
  })

  test('refund_status approved ingests (previously a non-ingesting event)', async () => {
    await notify({
      event: BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
      sessionId: 'sess-1',
      refundId: 'ref-1',
      refund: { refundId: 'ref-1', transactionId: 'tx-1', status: 'approved', amountIncVat: 100, currency: 'EUR' },
    })
    await flushIngestion()

    expect(mockIngestToOrder).toHaveBeenCalledWith('sess-1', 'order-1')
  })

  test('order_status approved ingests even when the handler early-returns (auth already Success)', async () => {
    mockFindPayments.mockResolvedValue([
      {
        id: 'pay-1',
        transactions: [
          {
            type: 'Authorization',
            interactionId: 'sess-1',
            state: 'Success',
            amount: { centAmount: 100, currencyCode: 'EUR' },
          },
        ],
      },
    ])

    await notify({
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
      sessionId: 'sess-1',
      cartId: 'cart-1',
      transaction: { transactionId: 'tx-1', status: 'approved', amountIncVat: 100, currency: 'EUR' },
    })
    await flushIngestion()

    expect(mockUpdatePayment).not.toHaveBeenCalled()
    expect(mockIngestToOrder).toHaveBeenCalledWith('sess-1', 'order-1')
  })

  test('session_status has no handler but still ingests and succeeds (no retry storm)', async () => {
    await expect(
      notify({
        event: BRIQPAY_WEBHOOK_EVENT.SESSION_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
        sessionId: 'sess-1',
        cartId: 'cart-1',
      }),
    ).resolves.toBeUndefined()
    await flushIngestion()

    expect(mockIngestToOrder).toHaveBeenCalledWith('sess-1', 'order-1')
  })

  test('malformed routable payload still ingests even though the gate error propagates', async () => {
    await expect(
      notify({
        event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.PENDING,
        sessionId: 'sess-1',
        cartId: 'cart-1',
      }),
    ).rejects.toThrow('Missing transaction data')
    await flushIngestion()

    expect(mockIngestToOrder).toHaveBeenCalledWith('sess-1', 'order-1')
  })

  test('payment-less cart never gets session data staged (no PII without a conversion path)', async () => {
    mockFindPayments.mockResolvedValue([])

    await notify({
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.PENDING,
      sessionId: 'sess-1',
      cartId: 'cart-1',
      transaction: { transactionId: 'tx-1', status: 'pending', amountIncVat: 100, currency: 'EUR' },
    })
    await flushIngestion()

    expect(mockIngestToCart).not.toHaveBeenCalled()
    expect(mockIngestToOrder).not.toHaveBeenCalled()
  })

  test('terminal order_status rejection never stages the cart even with a payment (no PII on dead carts)', async () => {
    mockOrdersGet.mockResolvedValue({ body: { results: [] } })

    await notify({
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.REJECTED,
      sessionId: 'sess-1',
      cartId: 'cart-1',
      transaction: { transactionId: 'tx-1', status: 'rejected', amountIncVat: 100, currency: 'EUR' },
    })
    await flushIngestion()

    expect(mockIngestToCart).not.toHaveBeenCalled()
    expect(mockIngestToOrder).not.toHaveBeenCalled()
  })

  test('terminal session_status never stages the cart even with a payment (no PII on dead carts)', async () => {
    mockOrdersGet.mockResolvedValue({ body: { results: [] } })

    await notify({
      event: BRIQPAY_WEBHOOK_EVENT.SESSION_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.REJECTED,
      sessionId: 'sess-1',
      cartId: 'cart-1',
    })
    await flushIngestion()

    expect(mockIngestToCart).not.toHaveBeenCalled()
    expect(mockIngestToOrder).not.toHaveBeenCalled()
  })

  test('capture_status rejected with a payment but no order still stages the cart (session is alive)', async () => {
    mockOrdersGet.mockResolvedValue({ body: { results: [] } })

    await notify({
      event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.REJECTED,
      sessionId: 'sess-1',
      cartId: 'cart-1',
      captureId: 'cap-1',
      capture: { captureId: 'cap-1', transactionId: 'tx-1', status: 'rejected', amountIncVat: 100, currency: 'EUR' },
    })
    await flushIngestion()

    expect(mockIngestToCart).toHaveBeenCalledWith('sess-1', 'cart-1')
  })

  test('ingestion failure never fails the webhook', async () => {
    mockFindPayments.mockResolvedValueOnce([]).mockRejectedValue(new Error('CT down'))

    await expect(
      notify({
        event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.PENDING,
        sessionId: 'sess-1',
        cartId: 'cart-1',
        transaction: { transactionId: 'tx-1', status: 'pending', amountIncVat: 100, currency: 'EUR' },
      }),
    ).resolves.toBeUndefined()
    await flushIngestion()

    expect(appLogger.error).toHaveBeenCalled()
    expect(mockIngestToOrder).not.toHaveBeenCalled()
    expect(mockIngestToCart).not.toHaveBeenCalled()
  })

  test('reuses the routing payment lookup instead of querying twice', async () => {
    await notify({
      event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
      sessionId: 'sess-1',
      captureId: 'cap-1',
      capture: { captureId: 'cap-1', transactionId: 'tx-1', status: 'approved', amountIncVat: 100, currency: 'EUR' },
    })
    await flushIngestion()

    expect(mockFindPayments).toHaveBeenCalledTimes(1)
    expect(mockIngestToOrder).toHaveBeenCalledWith('sess-1', 'order-1')
  })

  test('buyer-never-returns: handler-created payment is ingested via threading, not a re-query', async () => {
    // Routing lookup finds nothing; the pending handler creates the tagged payment, which is
    // threaded to ingestion. If it were NOT threaded, ingestOnWebhook would re-query (a 2nd
    // findPayments call) and - since that also returns [] - skip ingestion entirely.
    mockFindPayments.mockResolvedValue([])
    mockEnsurePayment.mockResolvedValue({ id: 'ensured-pay', transactions: [] })

    await notify({
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.PENDING,
      sessionId: 'sess-1',
      cartId: 'cart-1',
      transaction: { transactionId: 'tx-1', status: 'pending', amountIncVat: 100, currency: 'EUR' },
    })
    await flushIngestion()

    // Ingestion reached the order (via the order lookup on the created payment), and the
    // payment lookup ran exactly once - proving the created payment came through threading.
    expect(mockIngestToOrder).toHaveBeenCalledWith('sess-1', 'order-1')
    expect(mockFindPayments).toHaveBeenCalledTimes(1)
  })
})
