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

import { BriqpayNotificationService } from '../../../src/services/briqpay/notification.service'
import { appLogger } from '../../../src/payment-sdk'

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
