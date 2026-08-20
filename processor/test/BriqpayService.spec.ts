import BriqpayService from '../src/libs/briqpay/BriqpayService'
import { BRIQPAY_USER_AGENT } from '../src/libs/briqpay/user-agent'
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals'
import { mockGetCartResult } from './utils/mock-cart-data'
import { BRIQPAY_DECISION } from '../src/dtos/briqpay-payment.dto'
import { Cart } from '@commercetools/platform-sdk'
import { apiRoot } from '../src/libs/commercetools/api-root'
import { PaymentAmount } from '@commercetools/connect-payments-sdk/dist/commercetools/types/payment.type'
import { createHash } from 'crypto'

// updateSession takes a prebuilt request so the payload it sends is the one the hash
// describes. Tests go through the real builder to exercise that pairing.
const updateSessionWithCart = async (
  sessionId: string,
  cart: Cart,
  amount: { centAmount: number; currencyCode: string },
) =>
  BriqpayService.updateSession(sessionId, await BriqpayService.buildSessionUpdateRequest(cart, amount as PaymentAmount))

// Mock the apiRoot for fetchCartDiscountNames
jest.mock('../src/libs/commercetools/api-root', () => ({
  apiRoot: {
    cartDiscounts: jest.fn<any>(),
    taxCategories: jest.fn<any>(),
    productProjections: jest.fn<any>(),
  },
}))

// Mock the payment SDK setup
jest.mock('../src/payment-sdk', () => ({
  paymentSDK: {
    ctCartService: {
      getCart: jest.fn<any>(),
      addPayment: jest.fn<any>(),
      getPaymentAmount: jest.fn<any>(),
      getCartByPaymentId: jest.fn<any>(),
    },
    ctPaymentService: {
      getPayment: jest.fn<any>(),
      createPayment: jest.fn<any>(),
      updatePayment: jest.fn<any>(),
      hasTransactionInState: jest.fn<any>(),
    },
    ctAPI: {
      client: {
        execute: jest.fn<any>(),
        carts: jest.fn<any>().mockReturnValue({
          withId: jest.fn<any>().mockReturnValue({
            post: jest.fn<any>().mockReturnValue({
              execute: jest.fn<any>(),
            }),
          }),
        }),
        customObjects: jest.fn<any>().mockReturnValue({
          withContainerAndKey: jest.fn<any>().mockReturnValue({
            get: jest.fn<any>().mockReturnValue({
              execute: jest.fn<any>().mockReturnValue(
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
    info: jest.fn<any>(),
    error: jest.fn<any>(),
    warn: jest.fn<any>(),
  },
}))

// Helper to setup apiRoot mocks
const setupApiRootMocks = () => {
  ;(apiRoot.cartDiscounts as jest.Mock<any>).mockReturnValue({
    get: jest.fn<any>().mockReturnValue({
      execute: jest.fn<any>().mockResolvedValue({ body: { results: [] } }),
    }),
  })
  ;(apiRoot.taxCategories as jest.Mock<any>).mockReturnValue({
    withId: jest.fn<any>().mockReturnValue({
      get: jest.fn<any>().mockReturnValue({
        execute: jest.fn<any>().mockResolvedValue({ body: { rates: [{ country: 'GB', amount: 0.2 }] } }),
      }),
    }),
  })
  ;(apiRoot.productProjections as jest.Mock<any>).mockReturnValue({
    withId: jest.fn<any>().mockReturnValue({
      get: jest.fn<any>().mockReturnValue({
        execute: jest.fn<any>().mockResolvedValue({ body: { taxCategory: { id: 'tax-category-id' } } }),
      }),
    }),
  })
}

describe('BriqpayService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupApiRootMocks()
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
    expect(response.session).toHaveProperty('sessionId', 'abc123')
  })

  it('sends basic auth and the plugin User-Agent on Briqpay calls', async () => {
    const mockCart = JSON.parse(JSON.stringify(mockGetCartResult()))

    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        json: async () => ({ sessionId: 'abc123' }),
      } as Response),
    ) as typeof fetch

    await BriqpayService.createSession(
      mockCart,
      { centAmount: 10000, currencyCode: 'SEK', fractionDigits: 2 },
      'localhost',
    )

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(init.headers).toEqual({
      Authorization: expect.stringMatching(/^Basic /),
      'content-type': 'application/json',
      'User-Agent': BRIQPAY_USER_AGENT,
    })
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
    expect(response.session).toHaveProperty('sessionId', 'abc123')
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
    expect(response.session).toHaveProperty('sessionId', 'abc123')
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
    expect(response.session).toHaveProperty('sessionId', 'abc123')
  })

  it('forwards the cart briqpay-variant-id custom field as product.variantId', async () => {
    const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
    ;(mockCart as any).custom = { fields: { 'briqpay-variant-id': 'variant-abc' } }

    let requestBody: any = null
    global.fetch = jest.fn().mockImplementation((url, init: any) => {
      requestBody = init.body ? JSON.parse(init.body) : null
      return Promise.resolve({
        ok: true,
        json: async () => ({ sessionId: 'abc123' }),
      } as Response)
    }) as typeof fetch

    await BriqpayService.createSession(
      mockCart,
      { centAmount: 10000, currencyCode: 'SEK', fractionDigits: 2 },
      'localhost',
    )

    expect(requestBody.product.variantId).toBe('variant-abc')
  })

  it('omits product.variantId when the cart has no briqpay-variant-id custom field', async () => {
    const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart

    let requestBody: any = null
    global.fetch = jest.fn().mockImplementation((url, init: any) => {
      requestBody = init.body ? JSON.parse(init.body) : null
      return Promise.resolve({
        ok: true,
        json: async () => ({ sessionId: 'abc123' }),
      } as Response)
    }) as typeof fetch

    await BriqpayService.createSession(
      mockCart,
      { centAmount: 10000, currencyCode: 'SEK', fractionDigits: 2 },
      'localhost',
    )

    expect(requestBody.product).not.toHaveProperty('variantId')
  })

  it('activates the payment decision module on session creation', async () => {
    const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart

    let requestBody: any = null
    global.fetch = jest.fn().mockImplementation((url, init: any) => {
      requestBody = init.body ? JSON.parse(init.body) : null
      return Promise.resolve({
        ok: true,
        json: async () => ({ sessionId: 'abc123' }),
      } as Response)
    }) as typeof fetch

    await BriqpayService.createSession(
      mockCart,
      { centAmount: 10000, currencyCode: 'SEK', fractionDigits: 2 },
      'localhost',
    )

    expect(requestBody.modules.config.payment.decision).toEqual({ enabled: true })
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

    const response = await updateSessionWithCart('abc123', mockCart, {
      centAmount: mockCart.totalPrice.centAmount,
      currencyCode: mockCart.totalPrice.currencyCode,
    })

    expect(global.fetch).toHaveBeenCalled()
    expect(response).toEqual(mockUpdateResponse)
  })

  it('should throw an error when update session response is not ok', async () => {
    const mockCart = mockGetCartResult()

    // Mock text(), not json(): the body is read exactly once, since consuming it twice
    // throws on a real Response and loses the upstream detail.
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'Invalid data' } }),
      } as unknown as Response),
    ) as typeof fetch

    await expect(
      updateSessionWithCart('abc123', mockCart, {
        centAmount: mockCart.totalPrice.centAmount,
        currencyCode: mockCart.totalPrice.currencyCode,
      }),
    ).rejects.toThrow('Briqpay API error: {"error":{"message":"Invalid data"}}')
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
      updateSessionWithCart('abc123', mockCart, {
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

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.briqpay.com/',
        expect.objectContaining({
          headers: expect.objectContaining({ 'User-Agent': BRIQPAY_USER_AGENT }),
        }),
      )
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
        updateSessionWithCart('abc123', mockCart, {
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
        updateSessionWithCart('abc123', mockCart, {
          centAmount: mockCart.totalPrice.centAmount,
          currencyCode: mockCart.totalPrice.currencyCode,
        }),
      ).rejects.toThrow('Invalid Briqpay session response for abc123: missing sessionId')
    })
  })

  describe('session response normalization', () => {
    const amount = { centAmount: 119000, currencyCode: 'EUR' } as PaymentAmount

    it('normalizes a snippet-only GET response to htmlSnippet', async () => {
      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ sessionId: 'abc123', snippet: '<div>Briqpay</div>' }),
        } as Response),
      ) as typeof fetch

      const session = await BriqpayService.getSession('abc123')

      // Briqpay names it `snippet` on some responses; callers only ever read htmlSnippet.
      expect(session.htmlSnippet).toBe('<div>Briqpay</div>')
    })

    it('normalizes a snippet-only PATCH response to htmlSnippet', async () => {
      const mockCart = mockGetCartResult()
      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ sessionId: 'abc123', snippet: '<div>Briqpay Updated</div>' }),
        } as Response),
      ) as typeof fetch

      const session = await updateSessionWithCart('abc123', mockCart, {
        centAmount: mockCart.totalPrice.centAmount,
        currencyCode: mockCart.totalPrice.currencyCode,
      })

      expect(session.htmlSnippet).toBe('<div>Briqpay Updated</div>')
    })

    it('fails legibly when an update answers 204 instead of the session', async () => {
      const mockCart = mockGetCartResult()
      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          status: 204,
          json: async () => {
            throw new Error('no body')
          },
        } as unknown as Response),
      ) as typeof fetch

      // Only reachable by sending fields=none, which this connector never does - so fail
      // with something readable rather than a JSON parse error.
      await expect(
        updateSessionWithCart('abc123', mockCart, {
          centAmount: mockCart.totalPrice.centAmount,
          currencyCode: mockCart.totalPrice.currencyCode,
        }),
      ).rejects.toThrow('Briqpay returned 204 for session abc123')
    })

    it('omits shipping lines entirely for a cart with no shipping price', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as any
      delete mockCart.shippingInfo

      const request = await BriqpayService.buildSessionUpdateRequest(mockCart, amount)
      const sent = JSON.parse(request.body) as { data: { order: { cart: { reference: string }[] } } }

      expect(sent.data.order.cart.map((item) => item.reference)).not.toContain('shippingfee')
    })
  })

  describe('buildSessionUpdateRequest', () => {
    const amount = { centAmount: 119000, currencyCode: 'EUR' } as PaymentAmount

    it('is deterministic for an unchanged cart', async () => {
      const mockCart = mockGetCartResult()

      const first = await BriqpayService.buildSessionUpdateRequest(mockCart, amount)
      const second = await BriqpayService.buildSessionUpdateRequest(mockCart, amount)

      expect(second.body).toBe(first.body)
      expect(second.hash).toBe(first.hash)
    })

    it('hashes exactly the bytes it reports, and sends those same bytes', async () => {
      const mockCart = mockGetCartResult()
      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response),
      ) as typeof fetch

      const request = await BriqpayService.buildSessionUpdateRequest(mockCart, amount)
      await BriqpayService.updateSession('abc123', request)

      // The hash is only a true claim about what Briqpay holds if the body is sent verbatim.
      expect(request.hash).toBe(createHash('sha256').update(request.body).digest('hex'))
      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
      expect(init.body).toBe(request.body)
    })

    it('reports the amounts the payload carries, for the in-sync verification', async () => {
      const mockCart = mockGetCartResult()

      const request = await BriqpayService.buildSessionUpdateRequest(mockCart, amount)
      const sent = JSON.parse(request.body) as { data: { order: Record<string, unknown> } }

      expect(request.amounts).toEqual({
        currency: sent.data.order.currency,
        amountIncVat: sent.data.order.amountIncVat,
        amountExVat: sent.data.order.amountExVat,
      })
    })

    it('produces the same data subtree as createSession, so a create can record the hash', async () => {
      const mockCart = mockGetCartResult()
      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response),
      ) as typeof fetch

      const created = await BriqpayService.createSession(mockCart, amount, 'localhost')
      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
      const createdData = (JSON.parse(init.body as string) as { data: unknown }).data

      // Byte-identical `data`, otherwise the hash recorded after a create would describe a
      // payload that was never sent and the next /config would always look stale.
      expect(created.syncedPayloadHash).toBe(
        createHash('sha256')
          .update(JSON.stringify({ data: createdData }))
          .digest('hex'),
      )
    })

    it('changes the hash when discount name lookup degrades, so it never reads as in sync', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as any
      mockCart.lineItems[0].discountedPricePerQuantity = [
        {
          quantity: 1,
          discountedPrice: {
            value: { type: 'centPrecision', centAmount: 100000, currencyCode: 'EUR', fractionDigits: 2 },
            includedDiscounts: [
              {
                discount: { typeId: 'cart-discount', id: 'discount-id-1' },
                discountedAmount: {
                  type: 'centPrecision',
                  centAmount: 19000,
                  currencyCode: 'EUR',
                  fractionDigits: 2,
                },
              },
            ],
          },
        },
      ]
      mockCart.lineItems[0].taxedPrice = {
        totalGross: { centAmount: 100000, currencyCode: 'EUR' },
        totalNet: { centAmount: 84034, currencyCode: 'EUR' },
        totalTax: { centAmount: 15966, currencyCode: 'EUR' },
      }
      ;(apiRoot.cartDiscounts as jest.Mock<any>).mockReturnValue({
        get: jest.fn<any>().mockReturnValue({
          execute: jest
            .fn<any>()
            .mockResolvedValue({ body: { results: [{ id: 'discount-id-1', name: { en: 'Summer Sale' } }] } }),
        }),
      })
      const withNames = await BriqpayService.buildSessionUpdateRequest(mockCart, amount)
      expect(withNames.body).toContain('Summer Sale')

      // fetchCartDiscountNames swallows its own errors and falls back to a generic label,
      // so the same cart can map to a different payload. That must read as stale, not in sync.
      ;(apiRoot.cartDiscounts as jest.Mock<any>).mockReturnValue({
        get: jest.fn<any>().mockReturnValue({
          execute: jest.fn<any>().mockRejectedValue(new Error('CT unavailable')),
        }),
      })
      const degraded = await BriqpayService.buildSessionUpdateRequest(mockCart, amount)

      expect(degraded.body).not.toContain('Summer Sale')
      expect(degraded.hash).not.toBe(withNames.hash)
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
      expect(response.session).toHaveProperty('sessionId', 'abc123')
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
      expect(response.session).toHaveProperty('sessionId', 'abc123')
    })

    it('should create session with custom shipping method (no shippingMethod reference) and correct tax rate calculation', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      // Setup based on bug logs: 19% on line item, 0% on shipping fee, no shippingMethod reference
      ;(mockCart as any).lineItems[0].taxRate = { amount: 0.19 }
      delete (mockCart as any).shippingInfo.shippingMethod
      ;(mockCart as any).shippingInfo.price = { centAmount: 5000, currencyCode: 'RON' }
      ;(mockCart as any).shippingInfo.taxRate = { amount: 0 }
      // Mock cart taxedPrice
      ;(mockCart as any).taxedPrice = {
        totalNet: { centAmount: 120965, currencyCode: 'RON' },
        totalGross: { centAmount: 142998, currencyCode: 'RON' },
      }

      let requestBody: any = null
      global.fetch = jest.fn().mockImplementation((url, init: any) => {
        requestBody = JSON.parse(init.body)
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response)
      }) as typeof fetch

      const response = await BriqpayService.createSession(
        mockCart,
        { centAmount: 142998, currencyCode: 'RON', fractionDigits: 2 },
        'localhost',
      )

      expect(response.session).toHaveProperty('sessionId', 'abc123')
      expect(requestBody).toBeDefined()
      expect(requestBody.data.order.amountExVat).toBe(120965)

      const cartItems = requestBody.data.order.cart
      const shippingItem = cartItems.find((item: any) => item.productType === 'shipping_fee')
      expect(shippingItem).toBeDefined()
      expect(shippingItem.taxRate).toBe(0) // 0% * 10000
      expect(shippingItem.unitPrice).toBe(5000) // 5000 / (1 + 0)
      expect(shippingItem.totalVatAmount).toBe(0) // 5000 - 5000
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
      expect(response.session).toHaveProperty('sessionId', 'abc123')
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

      const response = await updateSessionWithCart('abc123', mockCart, {
        centAmount: 10000,
        currencyCode: 'EUR',
      })

      expect(response).toHaveProperty('sessionId', 'updated-session')
    })

    it('should update session with custom shipping method (no shippingMethod reference) and correct tax rate calculation', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      // Setup based on bug logs: 19% on line item, 0% on shipping fee, no shippingMethod reference
      ;(mockCart as any).lineItems[0].taxRate = { amount: 0.19 }
      delete (mockCart as any).shippingInfo.shippingMethod
      ;(mockCart as any).shippingInfo.price = { centAmount: 5000, currencyCode: 'RON' }
      ;(mockCart as any).shippingInfo.taxRate = { amount: 0 }
      // Mock cart taxedPrice to simulate exact rounding from CT
      ;(mockCart as any).taxedPrice = {
        totalNet: { centAmount: 120965, currencyCode: 'RON' },
        totalGross: { centAmount: 142998, currencyCode: 'RON' },
      }

      let requestBody: any = null
      global.fetch = jest.fn().mockImplementation((url, init: any) => {
        requestBody = JSON.parse(init.body)
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'updated-session' }),
        } as Response)
      }) as typeof fetch

      const response = await updateSessionWithCart('abc123', mockCart, {
        centAmount: 142998,
        currencyCode: 'RON',
      })

      expect(response).toHaveProperty('sessionId', 'updated-session')
      expect(requestBody).toBeDefined()
      expect(requestBody.data.order.amountExVat).toBe(120965)

      const cartItems = requestBody.data.order.cart
      const shippingItem = cartItems.find((item: any) => item.productType === 'shipping_fee')
      expect(shippingItem).toBeDefined()
      expect(shippingItem.taxRate).toBe(0) // 0% * 10000
      expect(shippingItem.unitPrice).toBe(5000) // 5000 / (1 + 0)
      expect(shippingItem.totalVatAmount).toBe(0) // 5000 - 5000
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

      const response = await updateSessionWithCart('abc123', mockCart, {
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

      expect(response.session).toHaveProperty('sessionId', 'abc123')
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

      expect(response.session).toHaveProperty('sessionId', 'abc123')
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

      expect(response.session).toHaveProperty('sessionId', 'abc123')
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

      expect(response.session).toHaveProperty('sessionId', 'abc123')
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

      expect(response.session).toHaveProperty('sessionId', 'abc123')
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

    it('should fallback to tax rate from product when line item has no tax rate', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult()))
      delete mockCart.lineItems[0].taxRate
      mockCart.lineItems[0].productId = 'product-with-tax-category'

      // Mock apiRoot for tax category lookup
      ;(apiRoot.taxCategories as jest.Mock<any>).mockReturnValue({
        withId: jest.fn<any>().mockReturnValue({
          get: jest.fn<any>().mockReturnValue({
            execute: jest.fn<any>().mockResolvedValue({
              body: {
                rates: [{ country: 'GB', amount: 0.2 }],
              },
            }),
          }),
        }),
      })
      ;(apiRoot.productProjections as jest.Mock<any>).mockReturnValue({
        withId: jest.fn<any>().mockReturnValue({
          get: jest.fn<any>().mockReturnValue({
            execute: jest.fn<any>().mockResolvedValue({
              body: {
                taxCategory: { id: 'tax-category-id' },
              },
            }),
          }),
        }),
      })

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

      expect(response.session).toHaveProperty('sessionId', 'abc123')
    })

    it('should handle tax category lookup with state matching', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult()))
      delete mockCart.lineItems[0].taxRate
      mockCart.lineItems[0].productId = 'product-with-tax-category'
      mockCart.shippingAddress.state = 'CA'
      ;(apiRoot.taxCategories as jest.Mock<any>).mockReturnValue({
        withId: jest.fn<any>().mockReturnValue({
          get: jest.fn<any>().mockReturnValue({
            execute: jest.fn<any>().mockResolvedValue({
              body: {
                rates: [
                  { country: 'GB', state: 'CA', amount: 0.25 },
                  { country: 'GB', amount: 0.2 },
                ],
              },
            }),
          }),
        }),
      })
      ;(apiRoot.productProjections as jest.Mock<any>).mockReturnValue({
        withId: jest.fn<any>().mockReturnValue({
          get: jest.fn<any>().mockReturnValue({
            execute: jest.fn<any>().mockResolvedValue({
              body: {
                taxCategory: { id: 'tax-category-id' },
              },
            }),
          }),
        }),
      })

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

      expect(response.session).toHaveProperty('sessionId', 'abc123')
    })

    it('should handle tax category lookup error gracefully', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult()))
      delete mockCart.lineItems[0].taxRate
      mockCart.lineItems[0].productId = 'product-with-tax-category'
      ;(apiRoot.productProjections as jest.Mock<any>).mockReturnValue({
        withId: jest.fn<any>().mockReturnValue({
          get: jest.fn<any>().mockReturnValue({
            execute: jest.fn<any>().mockRejectedValue(new Error('Product not found')),
          }),
        }),
      })

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

      expect(response.session).toHaveProperty('sessionId', 'abc123')
    })

    it('should handle tax category fetch error gracefully', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult()))
      delete mockCart.lineItems[0].taxRate
      mockCart.lineItems[0].productId = 'product-with-tax-category'
      ;(apiRoot.productProjections as jest.Mock<any>).mockReturnValue({
        withId: jest.fn<any>().mockReturnValue({
          get: jest.fn<any>().mockReturnValue({
            execute: jest.fn<any>().mockResolvedValue({
              body: {
                taxCategory: { id: 'tax-category-id' },
              },
            }),
          }),
        }),
      })
      ;(apiRoot.taxCategories as jest.Mock<any>).mockReturnValue({
        withId: jest.fn<any>().mockReturnValue({
          get: jest.fn<any>().mockReturnValue({
            execute: jest.fn<any>().mockRejectedValue(new Error('Tax category not found')),
          }),
        }),
      })

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

      expect(response.session).toHaveProperty('sessionId', 'abc123')
    })
  })

  describe('cart discount name fetching', () => {
    it('should fetch cart discount names for items with discounts', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as any
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
            includedDiscounts: [
              {
                discount: { typeId: 'cart-discount', id: 'discount-id-1' },
                discountedAmount: {
                  type: 'centPrecision',
                  centAmount: 19000,
                  currencyCode: 'EUR',
                  fractionDigits: 2,
                },
              },
            ],
          },
        },
      ]
      ;(mockCart.lineItems[0] as any).taxedPrice = {
        totalGross: { centAmount: 100000, currencyCode: 'EUR' },
        totalNet: { centAmount: 84034, currencyCode: 'EUR' },
        totalTax: { centAmount: 15966, currencyCode: 'EUR' },
      }
      ;(apiRoot.cartDiscounts as jest.Mock<any>).mockReturnValue({
        get: jest.fn<any>().mockReturnValue({
          execute: jest.fn<any>().mockResolvedValue({
            body: {
              results: [
                {
                  id: 'discount-id-1',
                  name: { en: 'Summer Sale', 'en-GB': 'Summer Sale GB' },
                  key: 'summer-sale',
                },
              ],
            },
          }),
        }),
      })

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

      expect(response.session).toHaveProperty('sessionId', 'abc123')
      expect(apiRoot.cartDiscounts).toHaveBeenCalled()
    })

    it('should handle cart discount fetch error gracefully', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as any
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
            includedDiscounts: [
              {
                discount: { typeId: 'cart-discount', id: 'discount-id-1' },
                discountedAmount: {
                  type: 'centPrecision',
                  centAmount: 19000,
                  currencyCode: 'EUR',
                  fractionDigits: 2,
                },
              },
            ],
          },
        },
      ]
      ;(mockCart.lineItems[0] as any).taxedPrice = {
        totalGross: { centAmount: 100000, currencyCode: 'EUR' },
        totalNet: { centAmount: 84034, currencyCode: 'EUR' },
        totalTax: { centAmount: 15966, currencyCode: 'EUR' },
      }
      ;(apiRoot.cartDiscounts as jest.Mock<any>).mockReturnValue({
        get: jest.fn<any>().mockReturnValue({
          execute: jest.fn<any>().mockRejectedValue(new Error('API error')),
        }),
      })

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

      expect(response.session).toHaveProperty('sessionId', 'abc123')
    })
  })

  describe('updateSession with discounts', () => {
    it('should update session with total discount on cart', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      ;(mockCart as any).discountOnTotalPrice = {
        discountedNetAmount: {
          centAmount: -1000,
          currencyCode: 'EUR',
        },
        discountedGrossAmount: {
          centAmount: -1190,
          currencyCode: 'EUR',
        },
        includedDiscounts: [{ discount: { id: 'discount-1', typeId: 'cart-discount' } }],
      }
      ;(apiRoot.cartDiscounts as jest.Mock<any>).mockReturnValue({
        get: jest.fn<any>().mockReturnValue({
          execute: jest.fn<any>().mockResolvedValue({
            body: {
              results: [{ id: 'discount-1', name: { en: 'Total Discount' } }],
            },
          }),
        }),
      })

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'updated-session' }),
        } as Response),
      ) as typeof fetch

      const response = await updateSessionWithCart('abc123', mockCart, {
        centAmount: 10000,
        currencyCode: 'EUR',
      })

      expect(response).toHaveProperty('sessionId', 'updated-session')
    })

    it('should update session with shipping discount', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      ;(mockCart as any).shippingInfo.discountedPrice = {
        value: {
          centAmount: 500,
          currencyCode: 'EUR',
        },
      }

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'updated-session' }),
        } as Response),
      ) as typeof fetch

      const response = await updateSessionWithCart('abc123', mockCart, {
        centAmount: 10000,
        currencyCode: 'EUR',
      })

      expect(response).toHaveProperty('sessionId', 'updated-session')
    })

    it('should handle zero net discount amount in addDiscountItemToCart', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      ;(mockCart as any).discountOnTotalPrice = {
        discountedNetAmount: {
          centAmount: 0,
          currencyCode: 'EUR',
        },
        discountedGrossAmount: {
          centAmount: 0,
          currencyCode: 'EUR',
        },
      }

      global.fetch = jest.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'updated-session' }),
        } as Response),
      ) as typeof fetch

      const response = await updateSessionWithCart('abc123', mockCart, {
        centAmount: 10000,
        currencyCode: 'EUR',
      })

      expect(response).toHaveProperty('sessionId', 'updated-session')
    })
  })

  describe('logFinalAmounts edge cases', () => {
    it('should handle cart with no items in logFinalAmounts', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as any
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

      expect(response.session).toHaveProperty('sessionId', 'abc123')
    })
  })

  describe('external webhook hooks', () => {
    const originalExternalUrl = process.env.BRIQPAY_EXTERNAL_WEBHOOK_URL

    afterEach(() => {
      if (originalExternalUrl === undefined) {
        delete process.env.BRIQPAY_EXTERNAL_WEBHOOK_URL
      } else {
        process.env.BRIQPAY_EXTERNAL_WEBHOOK_URL = originalExternalUrl
      }
    })

    it('should NOT include external hooks when BRIQPAY_EXTERNAL_WEBHOOK_URL is not set', async () => {
      delete process.env.BRIQPAY_EXTERNAL_WEBHOOK_URL
      const mockCart = mockGetCartResult()

      let requestBody: any = null
      global.fetch = jest.fn().mockImplementation((_url, init: any) => {
        requestBody = JSON.parse(init.body)
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response)
      }) as typeof fetch

      await BriqpayService.createSession(
        mockCart,
        { centAmount: 10000, currencyCode: 'SEK', fractionDigits: 2 },
        'localhost',
      )

      expect(requestBody.hooks).toHaveLength(3)
      expect(requestBody.hooks.every((h: any) => h.url === 'https://localhost/notifications')).toBe(true)
    })

    it('should include 3 additional external hooks when BRIQPAY_EXTERNAL_WEBHOOK_URL is set', async () => {
      process.env.BRIQPAY_EXTERNAL_WEBHOOK_URL = 'https://merchant.example.com/webhooks'
      const mockCart = mockGetCartResult()

      let requestBody: any = null
      global.fetch = jest.fn().mockImplementation((_url, init: any) => {
        requestBody = JSON.parse(init.body)
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response)
      }) as typeof fetch

      await BriqpayService.createSession(
        mockCart,
        { centAmount: 10000, currencyCode: 'SEK', fractionDigits: 2 },
        'localhost',
      )

      // 3 internal + 3 external = 6 hooks total
      expect(requestBody.hooks).toHaveLength(6)

      const externalHooks = requestBody.hooks.filter((h: any) => h.url === 'https://merchant.example.com/webhooks')
      expect(externalHooks).toHaveLength(3)

      const eventTypes = externalHooks.map((h: any) => h.eventType).sort()
      expect(eventTypes).toEqual(['capture_status', 'order_status', 'refund_status'])

      // All external hooks use POST
      expect(externalHooks.every((h: any) => h.method === 'POST')).toBe(true)

      // External order_status includes all ORDER_STATUS values
      const orderHook = externalHooks.find((h: any) => h.eventType === 'order_status')
      expect(orderHook.statuses).toEqual(
        expect.arrayContaining(['order_pending', 'order_rejected', 'order_cancelled', 'order_approved_not_captured']),
      )

      // External capture_status includes all TRANSACTION_STATUS values (including cancelled)
      const captureHook = externalHooks.find((h: any) => h.eventType === 'capture_status')
      expect(captureHook.statuses).toEqual(expect.arrayContaining(['pending', 'approved', 'rejected', 'cancelled']))

      // External refund_status includes all TRANSACTION_STATUS values (including cancelled)
      const refundHook = externalHooks.find((h: any) => h.eventType === 'refund_status')
      expect(refundHook.statuses).toEqual(expect.arrayContaining(['pending', 'approved', 'rejected', 'cancelled']))

      // Internal hooks are unchanged
      const internalHooks = requestBody.hooks.filter((h: any) => h.url === 'https://localhost/notifications')
      expect(internalHooks).toHaveLength(3)
    })
  })

  describe('custom line items', () => {
    const captureRequestBody = () => {
      let requestBody: any = null
      global.fetch = jest.fn().mockImplementation((url, init: any) => {
        requestBody = JSON.parse(init.body)
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123', captureId: 'cap123', status: 'approved' }),
        } as Response)
      }) as typeof fetch

      return () => requestBody
    }

    it('should map a positive custom line item as a physical cart item', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      const getRequestBody = captureRequestBody()

      await BriqpayService.createSession(
        mockCart,
        { centAmount: 238000, currencyCode: 'EUR', fractionDigits: 2 },
        'localhost',
      )

      const customItem = getRequestBody().data.order.cart.find((item: any) => item.reference === 'customLineItem-id-1')
      expect(customItem).toBeDefined()
      expect(customItem.productType).toBe('physical')
      expect(customItem.name).toBe('customLineItem-name-1')
      expect(customItem.quantity).toBe(1)
      expect(customItem.unitPrice).toBe(119000)
      expect(customItem.unitPriceIncVat).toBe(119000)
      expect(customItem.taxRate).toBe(0)
      expect(customItem.totalAmount).toBe(119000)
      expect(customItem.totalVatAmount).toBe(0)
    })

    it('should map a negative custom line item as a discount cart item', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as any
      mockCart.customLineItems[0].money.centAmount = -2503
      mockCart.customLineItems[0].totalPrice.centAmount = -2503
      const getRequestBody = captureRequestBody()

      await BriqpayService.createSession(
        mockCart,
        { centAmount: 116497, currencyCode: 'EUR', fractionDigits: 2 },
        'localhost',
      )

      const customItem = getRequestBody().data.order.cart.find((item: any) => item.reference === 'customLineItem-id-1')
      expect(customItem).toBeDefined()
      expect(customItem.productType).toBe('discount')
      expect(customItem.unitPrice).toBe(-2503)
      expect(customItem.unitPriceIncVat).toBe(-2503)
      expect(customItem.totalAmount).toBe(-2503)
      expect(customItem.totalVatAmount).toBe(0)
    })

    it('should use taxed amounts when custom line item has taxedPrice', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as any
      mockCart.customLineItems[0].quantity = 2
      mockCart.customLineItems[0].money.centAmount = 1250
      mockCart.customLineItems[0].taxRate = { amount: 0.25, includedInPrice: true }
      mockCart.customLineItems[0].taxedPrice = {
        totalNet: { centAmount: 2000, currencyCode: 'EUR', type: 'centPrecision', fractionDigits: 2 },
        totalGross: { centAmount: 2500, currencyCode: 'EUR', type: 'centPrecision', fractionDigits: 2 },
        totalTax: { centAmount: 500, currencyCode: 'EUR', type: 'centPrecision', fractionDigits: 2 },
        taxPortions: [],
      }
      const getRequestBody = captureRequestBody()

      await BriqpayService.createSession(
        mockCart,
        { centAmount: 121500, currencyCode: 'EUR', fractionDigits: 2 },
        'localhost',
      )

      const customItem = getRequestBody().data.order.cart.find((item: any) => item.reference === 'customLineItem-id-1')
      expect(customItem).toBeDefined()
      expect(customItem.productType).toBe('physical')
      expect(customItem.quantity).toBe(2)
      expect(customItem.unitPrice).toBe(1000)
      expect(customItem.unitPriceIncVat).toBe(1250)
      expect(customItem.taxRate).toBe(2500)
      expect(customItem.totalAmount).toBe(2500)
      expect(customItem.totalVatAmount).toBe(500)
    })

    it('should include custom line items in capture requests', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      const getRequestBody = captureRequestBody()

      await BriqpayService.capture(
        mockCart,
        { centAmount: mockCart.totalPrice.centAmount, currencyCode: mockCart.totalPrice.currencyCode },
        'abc123',
      )

      const customItem = getRequestBody().data.order.cart.find((item: any) => item.reference === 'customLineItem-id-1')
      expect(customItem).toBeDefined()
      expect(customItem.productType).toBe('physical')
      // No cart.taxedPrice on the fixture, so amountExVat comes from the line item
      // reduce (119000) plus the custom line item reduce (119000)
      expect(getRequestBody().data.order.amountExVat).toBe(238000)
    })

    it('should include custom line items in refund requests', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      const getRequestBody = captureRequestBody()

      await BriqpayService.refund(
        mockCart,
        { centAmount: mockCart.totalPrice.centAmount, currencyCode: mockCart.totalPrice.currencyCode },
        'abc123',
      )

      const customItem = getRequestBody().data.order.cart.find((item: any) => item.reference === 'customLineItem-id-1')
      expect(customItem).toBeDefined()
      expect(customItem.productType).toBe('physical')
      expect(getRequestBody().data.order.amountExVat).toBe(238000)
    })

    it('should include custom line items in updateSession requests', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as Cart
      let requestBody: any = null
      global.fetch = jest.fn().mockImplementation((url, init: any) => {
        requestBody = JSON.parse(init.body)
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'abc123' }),
        } as Response)
      }) as typeof fetch

      await updateSessionWithCart('abc123', mockCart, { centAmount: 238000, currencyCode: 'EUR' })

      const customItem = requestBody.data.order.cart.find((item: any) => item.reference === 'customLineItem-id-1')
      expect(customItem).toBeDefined()
      expect(customItem.productType).toBe('physical')
      expect(customItem.totalAmount).toBe(119000)
    })

    it('should not double-count quantity in capture amountExVat fallback when line item has taxedPrice', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as any
      // No cart.taxedPrice on the fixture, so the fallback reduce runs.
      // totalNet is the LINE total (quantity already applied) - must not be multiplied again.
      mockCart.lineItems[0].quantity = 2
      mockCart.lineItems[0].totalPrice.centAmount = 238000
      mockCart.lineItems[0].taxedPrice = {
        totalNet: { centAmount: 200000, currencyCode: 'EUR', type: 'centPrecision', fractionDigits: 2 },
        totalGross: { centAmount: 238000, currencyCode: 'EUR', type: 'centPrecision', fractionDigits: 2 },
        totalTax: { centAmount: 38000, currencyCode: 'EUR', type: 'centPrecision', fractionDigits: 2 },
        taxPortions: [],
      }
      const getRequestBody = captureRequestBody()

      await BriqpayService.capture(mockCart, { centAmount: 357000, currencyCode: 'EUR' }, 'abc123')

      // 200000 (line item totalNet, NOT x2) + 119000 (custom line item totalPrice)
      expect(getRequestBody().data.order.amountExVat).toBe(319000)
    })

    it('should not double-count quantity in refund amountExVat fallback when line item has taxedPrice', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as any
      mockCart.lineItems[0].quantity = 2
      mockCart.lineItems[0].totalPrice.centAmount = 238000
      mockCart.lineItems[0].taxedPrice = {
        totalNet: { centAmount: 200000, currencyCode: 'EUR', type: 'centPrecision', fractionDigits: 2 },
        totalGross: { centAmount: 238000, currencyCode: 'EUR', type: 'centPrecision', fractionDigits: 2 },
        totalTax: { centAmount: 38000, currencyCode: 'EUR', type: 'centPrecision', fractionDigits: 2 },
        taxPortions: [],
      }
      const getRequestBody = captureRequestBody()

      await BriqpayService.refund(mockCart, { centAmount: 357000, currencyCode: 'EUR' }, 'abc123')

      expect(getRequestBody().data.order.amountExVat).toBe(319000)
    })

    it('should derive unitPriceIncVat from taxed actuals, not the net/pre-discount money value', async () => {
      const mockCart = JSON.parse(JSON.stringify(mockGetCartResult())) as any
      // Tax-exclusive (US/B2B) pricing: money is NET and excludes any discounts
      mockCart.customLineItems[0].money.centAmount = 10000
      mockCart.customLineItems[0].taxRate = { amount: 0.25, includedInPrice: false }
      mockCart.customLineItems[0].taxedPrice = {
        totalNet: { centAmount: 10000, currencyCode: 'EUR', type: 'centPrecision', fractionDigits: 2 },
        totalGross: { centAmount: 12500, currencyCode: 'EUR', type: 'centPrecision', fractionDigits: 2 },
        totalTax: { centAmount: 2500, currencyCode: 'EUR', type: 'centPrecision', fractionDigits: 2 },
        taxPortions: [],
      }
      const getRequestBody = captureRequestBody()

      await BriqpayService.createSession(
        mockCart,
        { centAmount: 131500, currencyCode: 'EUR', fractionDigits: 2 },
        'localhost',
      )

      const customItem = getRequestBody().data.order.cart.find((item: any) => item.reference === 'customLineItem-id-1')
      expect(customItem).toBeDefined()
      expect(customItem.unitPrice).toBe(10000)
      expect(customItem.unitPriceIncVat).toBe(12500) // gross actual, NOT money (10000)
      expect(customItem.totalAmount).toBe(12500)
      expect(customItem.totalVatAmount).toBe(2500)
    })
  })
})
