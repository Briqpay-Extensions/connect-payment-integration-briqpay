/* eslint-disable @typescript-eslint/no-explicit-any */
import BriqpayService from '../src/libs/briqpay/BriqpayService'
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals'
import { mockGetCartResult } from './utils/mock-cart-data'
import { BRIQPAY_DECISION } from '../src/dtos/briqpay-payment.dto'
import { Cart } from '@commercetools/platform-sdk'

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

    const response = await BriqpayService.createSession(
      mockCart,
      {
        centAmount: 10000,
        currencyCode: 'SEK',
        fractionDigits: 2,
      },
      'localhost',
    )

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

    const response = await BriqpayService.createSession(
      mockCart,
      {
        centAmount: 10000,
        currencyCode: 'SEK',
        fractionDigits: 2,
      },
      'localhost',
    )

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

    const response = await BriqpayService.createSession(
      mockCart,
      {
        centAmount: 10000,
        currencyCode: 'SEK',
        fractionDigits: 2,
      },
      'localhost',
    )

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

    const response = await BriqpayService.createSession(
      mockCart,
      {
        centAmount: 10000,
        currencyCode: 'SEK',
        fractionDigits: 2,
      },
      'localhost',
    )

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

    const response = await BriqpayService.updateSession('abc123', mockCart, {
      centAmount: mockCart.totalPrice.centAmount,
      currencyCode: mockCart.totalPrice.currencyCode,
    })

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
      BriqpayService.updateSession('abc123', mockCart, {
        centAmount: mockCart.totalPrice.centAmount,
        currencyCode: mockCart.totalPrice.currencyCode,
      }),
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
      BriqpayService.updateSession('abc123', mockCart, {
        centAmount: mockCart.totalPrice.centAmount,
        currencyCode: mockCart.totalPrice.currencyCode,
      }),
    ).rejects.toThrow('Failed to parse response')
  })

  describe('healthCheck', () => {
    beforeEach(() => {
      global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('should return response when health check succeeds', async () => {
      const mockResponse = { ok: true, status: 200 } as Response
      ;(global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue(mockResponse)

      const result = await BriqpayService.healthCheck()

      expect(global.fetch).toHaveBeenCalledWith('https://mock-briqpay.api')
      expect(result).toBe(mockResponse)
    })

    it('should throw error when health check fails', async () => {
      const mockResponse = { ok: false, status: 500 } as Response
      ;(global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue(mockResponse)

      await expect(BriqpayService.healthCheck()).rejects.toThrow('Health check failed with status 500')
    })
  })

  describe('createSession error handling', () => {
    it('should throw error when createSession response is not ok', async () => {
      const mockCart = mockGetCartResult()

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => 'Invalid session data',
        } as unknown as Response),
      ) as typeof fetch

      await expect(
        BriqpayService.createSession(
          mockCart,
          { centAmount: 10000, currencyCode: 'SEK', fractionDigits: 2 },
          'localhost',
        ),
      ).rejects.toThrow('Briqpay session creation failed: 400 Bad Request')
    })

    it('should throw error when createSession response is missing sessionId', async () => {
      const mockCart = mockGetCartResult()

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ someOtherField: 'value' }),
        } as Response),
      ) as typeof fetch

      await expect(
        BriqpayService.createSession(
          mockCart,
          { centAmount: 10000, currencyCode: 'SEK', fractionDigits: 2 },
          'localhost',
        ),
      ).rejects.toThrow('Invalid Briqpay session response: missing sessionId')
    })
  })

  describe('refund error handling', () => {
    it('should throw error when refund response is not ok', async () => {
      const mockCart = mockGetCartResult()

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: false,
          status: 400,
          text: async () => 'Refund failed: insufficient funds',
        } as unknown as Response),
      ) as typeof fetch

      await expect(
        BriqpayService.refund(mockCart, { centAmount: 10000, currencyCode: 'EUR' }, 'session123', 'capture123'),
      ).rejects.toThrow('Briqpay refund error: Refund failed: insufficient funds')
    })
  })

  describe('updateSession error handling', () => {
    it('should handle non-JSON error response in updateSession', async () => {
      const mockCart = mockGetCartResult()

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: false,
          status: 500,
          json: async () => {
            throw new Error('Not JSON')
          },
          text: async () => 'Internal server error text',
        } as unknown as Response),
      ) as typeof fetch

      await expect(
        BriqpayService.updateSession('abc123', mockCart, {
          centAmount: mockCart.totalPrice.centAmount,
          currencyCode: mockCart.totalPrice.currencyCode,
        }),
      ).rejects.toThrow('Briqpay API error: Internal server error text')
    })

    it('should throw error when updateSession response is missing sessionId', async () => {
      const mockCart = mockGetCartResult()

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ someField: 'value' }),
        } as Response),
      ) as typeof fetch

      await expect(
        BriqpayService.updateSession('abc123', mockCart, {
          centAmount: mockCart.totalPrice.centAmount,
          currencyCode: mockCart.totalPrice.currencyCode,
        }),
      ).rejects.toThrow('Invalid session response: missing sessionId')
    })
  })

  describe('cart with discounts', () => {
    it('should create session with total discount on cart', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      // Add discount on total price
      ;(mockCart as any).discountOnTotalPrice = {
        discountedNetAmount: {
          centAmount: -1000,
          currencyCode: 'EUR',
        },
        discountedGrossAmount: {
          centAmount: -1190,
          currencyCode: 'EUR',
        },
      }

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response),
      ) as typeof fetch

      const response = await BriqpayService.createSession(
        mockCart,
        { centAmount: 10000, currencyCode: 'EUR', fractionDigits: 2 },
        'localhost',
      )

      expect(global.fetch).toHaveBeenCalled()
      expect(response).toHaveProperty('sessionId', 'abc123')
    })

    it('should create session with discounted shipping', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      // Add discounted shipping
      ;(mockCart as any).shippingInfo.discountedPrice = {
        value: {
          centAmount: 500,
          currencyCode: 'EUR',
        },
      }
      ;(mockCart as any).shippingInfo.shippingMethod = { id: 'shipping-method-id' }

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response),
      ) as typeof fetch

      const response = await BriqpayService.createSession(
        mockCart,
        { centAmount: 10000, currencyCode: 'EUR', fractionDigits: 2 },
        'localhost',
      )

      expect(global.fetch).toHaveBeenCalled()
      expect(response).toHaveProperty('sessionId', 'abc123')
    })

    it('should skip shipping when fully discounted (zero price)', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      // Fully discounted shipping
      ;(mockCart as any).shippingInfo.discountedPrice = {
        value: {
          centAmount: 0,
          currencyCode: 'EUR',
        },
      }
      ;(mockCart as any).shippingInfo.shippingMethod = { id: 'shipping-method-id' }

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response),
      ) as typeof fetch

      const response = await BriqpayService.createSession(
        mockCart,
        { centAmount: 10000, currencyCode: 'EUR', fractionDigits: 2 },
        'localhost',
      )

      expect(global.fetch).toHaveBeenCalled()
      expect(response).toHaveProperty('sessionId', 'abc123')
    })
  })

  describe('updateSession with shipping', () => {
    it('should update session with shipping item', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      ;(mockCart as any).shippingInfo.shippingMethod = { id: 'shipping-method-id' }

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'updated-session' }),
        } as Response),
      ) as typeof fetch

      const response = await BriqpayService.updateSession('abc123', mockCart, {
        centAmount: 10000,
        currencyCode: 'EUR',
      })

      expect(response).toHaveProperty('sessionId', 'updated-session')
    })

    it('should skip shipping in updateSession when fully discounted', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      ;(mockCart as any).shippingInfo.discountedPrice = {
        value: { centAmount: 0, currencyCode: 'EUR' },
      }

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'updated-session' }),
        } as Response),
      ) as typeof fetch

      const response = await BriqpayService.updateSession('abc123', mockCart, {
        centAmount: 10000,
        currencyCode: 'EUR',
      })

      expect(response).toHaveProperty('sessionId', 'updated-session')
    })
  })

  describe('cart item mapping edge cases', () => {
    it('should handle discounted price mode items', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult()))
      mockCart.lineItems[0].priceMode = 'Discounted'

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response),
      ) as typeof fetch

      const response = await BriqpayService.createSession(
        mockCart,
        { centAmount: 10000, currencyCode: 'EUR', fractionDigits: 2 },
        'localhost',
      )

      expect(response).toHaveProperty('sessionId', 'abc123')
    })

    it('should handle items with discountedPricePerQuantity', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult()))
      mockCart.lineItems[0].discountedPricePerQuantity = [
        {
          quantity: 1,
          discountedPrice: {
            value: {
              type: 'centPrecision',
              centAmount: 100000,
              currencyCode: 'EUR',
              fractionDigits: 2,
            },
            includedDiscounts: [],
          },
        },
      ]

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response),
      ) as typeof fetch

      const response = await BriqpayService.createSession(
        mockCart,
        { centAmount: 10000, currencyCode: 'EUR', fractionDigits: 2 },
        'localhost',
      )

      expect(response).toHaveProperty('sessionId', 'abc123')
    })

    it('should use fallback locale when cart locale is missing', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      delete (mockCart as any).locale

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response),
      ) as typeof fetch

      const response = await BriqpayService.createSession(
        mockCart,
        { centAmount: 10000, currencyCode: 'EUR', fractionDigits: 2 },
        'localhost',
      )

      expect(response).toHaveProperty('sessionId', 'abc123')
    })

    it('should use productKey as fallback name', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      delete (mockCart.lineItems[0] as any).name
      ;(mockCart.lineItems[0] as any).productKey = 'product-key-fallback'

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response),
      ) as typeof fetch

      const response = await BriqpayService.createSession(
        mockCart,
        { centAmount: 10000, currencyCode: 'EUR', fractionDigits: 2 },
        'localhost',
      )

      expect(response).toHaveProperty('sessionId', 'abc123')
    })
  })

  describe('tax rate fallback', () => {
    it('should use shipping tax rate when line item tax rate is missing', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult()))
      delete mockCart.lineItems[0].taxRate
      mockCart.lineItems = []

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response),
      ) as typeof fetch

      const response = await BriqpayService.createSession(
        mockCart,
        { centAmount: 10000, currencyCode: 'EUR', fractionDigits: 2 },
        'localhost',
      )

      expect(response).toHaveProperty('sessionId', 'abc123')
    })

    it('should throw error when no tax rate can be determined', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult()))
      mockCart.lineItems = []
      delete mockCart.shippingInfo.taxRate

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response),
      ) as typeof fetch

      await expect(
        BriqpayService.createSession(
          mockCart,
          { centAmount: 10000, currencyCode: 'EUR', fractionDigits: 2 },
          'localhost',
        ),
      ).rejects.toThrow('Could not determine effective tax rate')
    })
  })
})
