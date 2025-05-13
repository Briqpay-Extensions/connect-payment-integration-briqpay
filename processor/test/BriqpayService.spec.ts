import BriqpayService from '../src/libs/briqpay/BriqpayService'
import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { mockGetCartResult } from './utils/mock-cart-data'
import { BRIQPAY_DECISION } from '../src/dtos/briqpay-payment.dto'

// Mock the Commercetools SDK client
jest.mock('@commercetools/sdk-client-v2', () => ({
  ClientBuilder: jest.fn().mockImplementation(() => ({
    withClientCredentialsFlow: jest.fn().mockReturnThis(),
    withProjectKey: jest.fn().mockReturnThis(),
    withHttpMiddleware: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({
      execute: jest.fn().mockResolvedValue({ body: {} } as unknown as never),
    }),
  })),
  ClientResponse: jest.fn().mockImplementation(() => ({
    body: {} as unknown,
  })),
}))

// Mock the payment SDK setup
jest.mock('../src/payment-sdk', () => ({
  paymentSDK: {
    ctCartService: {
      getCart: jest.fn(),
      addPayment: jest.fn(),
      getPaymentAmount: jest.fn(),
      getCartByPaymentId: jest.fn(),
    },
    ctPaymentService: {
      getPayment: jest.fn(),
      createPayment: jest.fn(),
      updatePayment: jest.fn(),
      hasTransactionInState: jest.fn(),
    },
    ctAPI: {
      client: {
        execute: jest.fn(),
        carts: jest.fn().mockReturnValue({
          withId: jest.fn().mockReturnValue({
            post: jest.fn().mockReturnValue({
              execute: jest.fn(),
            }),
          }),
        }),

        customObjects: jest.fn().mockReturnValue({
          withContainerAndKey: jest.fn().mockReturnValue({
            get: jest.fn().mockReturnValue({
              execute: jest.fn().mockReturnValue(
                Promise.resolve({
                  body: {
                    value: {
                      url: process.env.BRIQPAY_PROCESSOR_URL_CUSTOM_TYPE_KEY as string,
                    },
                  },
                }),
              ),
            }),
          }),
        }),
      },
    },
  },
  appLogger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}))

describe('BriqpayService', () => {
  beforeEach(() => {
    // global.fetch = jest.fn().mockReturnValue(
    //   Promise.resolve({
    //     ok: true,
    //     json: async () => ({ sessionId: 'abc123' }),
    //   } as Response),
    // ) as typeof fetch
  })

  it('should create a session with gift cards', async () => {
    const mockCart = JSON.parse(JSON.stringify(mockGetCartResult()))
    mockCart.lineItems[0].lineItemMode = 'GiftCard'

    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        json: async () => ({ sessionId: 'abc123' }),
      } as Response),
    ) as typeof fetch

    const response = await BriqpayService.createSession(mockCart, {
      centAmount: 10000,
      currencyCode: 'SEK',
      fractionDigits: 2,
    })

    expect(global.fetch).toHaveBeenCalled()
    expect(response).toHaveProperty('sessionId', 'abc123')
  })

  it('should create a session with digital items', async () => {
    const mockCart = JSON.parse(JSON.stringify(mockGetCartResult()))
    mockCart.lineItems[0].variant.attributes = [
      {
        name: 'isDigital',
        value: 'true',
      },
    ]

    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        json: async () => ({ sessionId: 'abc123' }),
      } as Response),
    ) as typeof fetch

    const response = await BriqpayService.createSession(mockCart, {
      centAmount: 10000,
      currencyCode: 'SEK',
      fractionDigits: 2,
    })

    expect(global.fetch).toHaveBeenCalled()
    expect(response).toHaveProperty('sessionId', 'abc123')
  })

  it('should create a session with digital items #2', async () => {
    const mockCart = JSON.parse(JSON.stringify(mockGetCartResult()))
    mockCart.lineItems[0].productType.id = 'digital'

    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        json: async () => ({ sessionId: 'abc123' }),
      } as Response),
    ) as typeof fetch

    const response = await BriqpayService.createSession(mockCart, {
      centAmount: 10000,
      currencyCode: 'SEK',
      fractionDigits: 2,
    })

    expect(global.fetch).toHaveBeenCalled()
    expect(response).toHaveProperty('sessionId', 'abc123')
  })

  it('should create a session with expected payload', async () => {
    const mockCart = mockGetCartResult()

    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        json: async () => ({ sessionId: 'abc123' }),
      } as Response),
    ) as typeof fetch

    const response = await BriqpayService.createSession(mockCart, {
      centAmount: 10000,
      currencyCode: 'SEK',
      fractionDigits: 2,
    })

    expect(global.fetch).toHaveBeenCalled()
    expect(response).toHaveProperty('sessionId', 'abc123')
  })

  it('should get a session by ID', async () => {
    const result = await BriqpayService.getSession('abc123')
    expect(result).toEqual({ sessionId: 'abc123' })
  })

  it('should parse an error when response.text() works in getSession', async () => {
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 400,
        text: async () => 'Something went wrong',
      } as unknown as Response),
    ) as typeof fetch

    await expect(BriqpayService.getSession('abc123')).rejects.toThrow('Briqpay API error: Something went wrong')
  })

  it('should throw an error when response.text() fails in getSession', async () => {
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 400,
        text: async () => {
          throw new Error('Failed to parse response')
        },
      } as unknown as Response),
    ) as typeof fetch

    await expect(BriqpayService.getSession('abc123')).rejects.toThrow('Failed to parse response')
  })

  it('should capture an order successfully', async () => {
    const mockCart = mockGetCartResult()

    const mockCaptureResponse = { captureId: 'capture123', status: 'captured' }

    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        json: async () => mockCaptureResponse,
      } as Response),
    ) as typeof fetch

    const response = await BriqpayService.capture(
      mockCart,
      { centAmount: mockCart.totalPrice.centAmount, currencyCode: mockCart.totalPrice.currencyCode },
      'abc123',
    )

    expect(global.fetch).toHaveBeenCalled()
    expect(response).toEqual(mockCaptureResponse)
  })

  it('should refund an order successfully', async () => {
    const mockCart = mockGetCartResult()

    const mockRefundResponse = { refundId: 'refund123', status: 'refunded' }

    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        json: async () => mockRefundResponse,
      } as Response),
    ) as typeof fetch

    const response = await BriqpayService.refund(
      mockCart,
      { centAmount: mockCart.totalPrice.centAmount, currencyCode: mockCart.totalPrice.currencyCode },
      'abc123',
    )

    expect(global.fetch).toHaveBeenCalled()
    expect(response).toEqual(mockRefundResponse)
  })

  it('should make a decision successfully', async () => {
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        status: 204,
      } as Response),
    ) as typeof fetch

    const response = await BriqpayService.makeDecision('abc123', { decision: BRIQPAY_DECISION.ALLOW })

    expect(global.fetch).toHaveBeenCalled()
    expect(response.status).toEqual(204)
  })

  it('should cancel an order successfully', async () => {
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        status: 204,
      } as Response),
    ) as typeof fetch

    const response = await BriqpayService.cancel('abc123')

    expect(global.fetch).toHaveBeenCalled()
    expect(response.status).toEqual('approved')
  })

  it('should parse an error when response.text() works in cancel', async () => {
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 400,
        text: async () => 'Something went wrong',
      } as unknown as Response),
    ) as typeof fetch

    await expect(BriqpayService.cancel('abc123')).rejects.toThrow('Briqpay cancel error: Something went wrong')
  })

  it('should update a session successfully', async () => {
    const mockCart = mockGetCartResult()

    const mockUpdateResponse = { sessionId: 'updated-session-id' }

    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        json: async () => mockUpdateResponse,
      } as Response),
    ) as typeof fetch

    const response = await BriqpayService.updateSession(
      mockCart,
      { centAmount: mockCart.totalPrice.centAmount, currencyCode: mockCart.totalPrice.currencyCode },
      'abc123',
    )

    expect(global.fetch).toHaveBeenCalled()
    expect(response).toEqual(mockUpdateResponse)
  })

  it('should throw an error when update session response is not ok', async () => {
    const mockCart = mockGetCartResult()

    const mockErrorResponse = { error: { message: 'Invalid data' } }

    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 400,
        json: async () => mockErrorResponse,
      } as Response),
    ) as typeof fetch

    await expect(
      BriqpayService.updateSession(
        mockCart,
        { centAmount: mockCart.totalPrice.centAmount, currencyCode: mockCart.totalPrice.currencyCode },
        'abc123',
      ),
    ).rejects.toThrow('Briqpay API error: Invalid data')
  })

  it('should throw an error when response.text() fails', async () => {
    const mockCart = mockGetCartResult()

    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 400,
        text: async () => {
          throw new Error('Failed to parse response')
        }, // Simulate text read failure
      } as unknown as Response),
    ) as typeof fetch

    await expect(
      BriqpayService.updateSession(
        mockCart,
        { centAmount: mockCart.totalPrice.centAmount, currencyCode: mockCart.totalPrice.currencyCode },
        'abc123',
      ),
    ).rejects.toThrow('Failed to parse response')
  })
})
