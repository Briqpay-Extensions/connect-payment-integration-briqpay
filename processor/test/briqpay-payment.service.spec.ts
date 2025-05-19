import { describe, test, expect, afterEach, jest, beforeEach } from '@jest/globals'
import { ConfigResponse, ModifyPayment, StatusResponse } from '../src/services/types/operation.type'
import { paymentSDK } from '../src/payment-sdk'
import { DefaultPaymentService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-payment.service'
import { DefaultCartService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-cart.service'
import { mockGetPaymentResult, mockUpdatePaymentResult } from './utils/mock-payment-results'
import { mockGetCartResult } from './utils/mock-cart-data'
import * as Config from '../src/config/config'
import {
  CreatePaymentRequest,
  BriqpayPaymentServiceOptions,
  ITEM_PRODUCT_TYPE,
} from '../src/services/types/briqpay-payment.type'
import { AbstractPaymentService } from '../src/services/abstract-payment.service'
import { BriqpayPaymentService } from '../src/services/briqpay-payment.service'
import * as FastifyContext from '../src/libs/fastify/context/context'
import * as StatusHandler from '@commercetools/connect-payments-sdk/dist/api/handlers/status.handler'
import {
  BRIQPAY_WEBHOOK_EVENT,
  BRIQPAY_WEBHOOK_STATUS,
  PaymentMethodType,
  PaymentOutcome,
} from '../src/dtos/briqpay-payment.dto'
import { TransactionDraftDTO } from '../src/dtos/operations/transaction.dto'
import Briqpay from '../src/libs/briqpay/BriqpayService'
import { ByProjectKeyCartsRequestBuilder, Cart } from '@commercetools/platform-sdk'
import { briqpaySessionIdCustomType } from '../src/custom-types/custom-types'

// Mock the Commercetools SDK client
jest.mock('@commercetools/sdk-client-v2', () => ({
  ClientBuilder: jest.fn().mockImplementation(() => ({
    withClientCredentialsFlow: jest.fn().mockReturnThis(),
    withProjectKey: jest.fn().mockReturnThis(),
    withHttpMiddleware: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({
      execute: jest.fn().mockResolvedValue({ body: { version: 1 } } as unknown as never),
    }),
  })),
  ClientResponse: jest.fn().mockImplementation(() => ({
    body: { version: 1 } as unknown,
  })),
}))

// Mock the payment SDK setup
jest.mock('../src/payment-sdk', () => ({
  paymentSDK: {
    ctCartService: {
      getCart: jest.fn(),
      addPayment: jest.fn(),
      getPaymentAmount: jest.fn(),
      getPlannedPaymentAmount: jest.fn(),
      getCartByPaymentId: jest.fn(),
    },
    ctPaymentService: {
      getPayment: jest.fn(),
      createPayment: jest.fn(),
      updatePayment: jest.fn(),
      hasTransactionInState: jest.fn(),
      findPaymentsByInterfaceId: jest.fn(),
    },
    ctAPI: {
      client: {
        execute: jest.fn(),
        carts: jest.fn().mockReturnValue({
          withId: jest.fn().mockReturnValue({
            post: jest.fn().mockReturnValue({
              execute: jest.fn().mockResolvedValue({ body: { version: 1 } } as unknown as never),
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

interface FlexibleConfig {
  [key: string]: string // Adjust the type according to your config values
}

function setupMockConfig(keysAndValues: Record<string, string>) {
  const mockConfig: FlexibleConfig = {}
  Object.keys(keysAndValues).forEach((key) => {
    mockConfig[key] = keysAndValues[key]
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jest.spyOn(Config, 'getConfig').mockReturnValue(mockConfig as any)
}

describe('briqpay-payment.service', () => {
  const opts: BriqpayPaymentServiceOptions = {
    ctCartService: paymentSDK.ctCartService,
    ctPaymentService: paymentSDK.ctPaymentService,
  }
  const paymentService: AbstractPaymentService = new BriqpayPaymentService(opts)
  const briqpayPaymentService: BriqpayPaymentService = new BriqpayPaymentService(opts)
  beforeEach(() => {
    jest.setTimeout(10000)
    jest.resetAllMocks()
    // Mock Briqpay service methods
    const mockBriqpayResponse = {
      sessionId: 'abc123',
      status: PaymentOutcome.APPROVED,
      htmlSnippet: '<div>Briqpay</div>',
      data: {
        order: {
          amountIncVat: 119000,
          currency: 'EUR',
          cart: [],
        },
      },
    }
    jest.spyOn(Briqpay, 'createSession').mockReturnValue(Promise.resolve(mockBriqpayResponse))
    jest.spyOn(Briqpay, 'getSession').mockReturnValue(Promise.resolve(mockBriqpayResponse))
    jest.spyOn(Briqpay, 'capture').mockReturnValue(
      Promise.resolve({
        captureId: '123',
        status: PaymentOutcome.APPROVED,
      }),
    )
    jest.spyOn(Briqpay, 'refund').mockReturnValue(
      Promise.resolve({
        refundId: '123',
        status: PaymentOutcome.APPROVED,
      }),
    )

    // Mock payment SDK methods with simplified responses
    jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue(mockGetCartResult())
    jest.spyOn(paymentSDK.ctCartService, 'addPayment').mockResolvedValue(mockGetCartResult())
    jest.spyOn(paymentSDK.ctCartService, 'getCartByPaymentId').mockResolvedValue(mockGetCartResult())
    jest.spyOn(paymentSDK.ctCartService, 'getPaymentAmount').mockResolvedValue({
      centAmount: 119000,
      currencyCode: 'EUR',
      fractionDigits: 2,
    })
    jest.spyOn(paymentSDK.ctCartService, 'getPlannedPaymentAmount').mockResolvedValue({
      centAmount: 119000,
      currencyCode: 'EUR',
      fractionDigits: 2,
    })
    jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockGetPaymentResult)
    jest.spyOn(paymentSDK.ctPaymentService, 'createPayment').mockResolvedValue(mockGetPaymentResult)
    jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValue(mockUpdatePaymentResult)
    jest
      .spyOn(paymentSDK.ctAPI.client, 'execute' as keyof typeof paymentSDK.ctAPI.client)
      .mockResolvedValue({ body: { version: 1 } } as unknown as never)

    // Mock the carts API
    paymentSDK.ctAPI.client.carts = jest.fn().mockReturnValue({
      withId: jest.fn().mockReturnValue({
        post: jest.fn().mockReturnValue({
          execute: jest.fn().mockResolvedValue({ body: { version: 1 } } as unknown as never),
        }),
      }),
    }) as unknown as () => ByProjectKeyCartsRequestBuilder
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('getConfig', async () => {
    // Setup mock config for a system using `clientKey`
    setupMockConfig({ mockClientKey: '', mockEnvironment: 'test' })
    jest.spyOn(Briqpay, 'createSession').mockReturnValue(
      Promise.resolve({
        sessionId: 'abc123',
      }),
    )

    const result: ConfigResponse = await paymentService.config('localhost')

    // Assertions can remain the same or be adapted based on the abstracted access
    expect(result?.briqpaySessionId).toStrictEqual('abc123')
  })

  test('getConfig with existing session', async () => {
    jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue({
      ...mockGetCartResult(),
      custom: {
        type: { typeId: 'type', id: 'briqpay-session-id' }, // This matches your type definition
        fields: {
          [briqpaySessionIdCustomType.name]: 'abc123',
        },
      },
    })

    // Setup mock config for a system using `clientKey`
    setupMockConfig({ mockClientKey: '', mockEnvironment: 'test' })
    jest.spyOn(Briqpay, 'createSession').mockReturnValue(
      Promise.resolve({
        sessionId: 'abc123',
      }),
    )

    const result: ConfigResponse = await paymentService.config('localhost')

    // Assertions can remain the same or be adapted based on the abstracted access
    expect(result?.briqpaySessionId).toStrictEqual('abc123')
  })

  test('getConfig with missing billing address', async () => {
    jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue({
      ...mockGetCartResult(),
      billingAddress: undefined,
    })

    setupMockConfig({ mockClientKey: '', mockEnvironment: 'test' })
    jest.spyOn(Briqpay, 'createSession').mockReturnValue(
      Promise.resolve({
        sessionId: 'abc123',
      }),
    )

    await expect(paymentService.config('localhost')).rejects.toThrow(
      'Cart is missing a billing address. Taxes cannot be calculated.',
    )
  })

  test('getConfig with missing shipping address', async () => {
    jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue({
      ...mockGetCartResult(),
      shippingAddress: undefined,
    })

    setupMockConfig({ mockClientKey: '', mockEnvironment: 'test' })
    jest.spyOn(Briqpay, 'createSession').mockReturnValue(
      Promise.resolve({
        sessionId: 'abc123',
      }),
    )

    await expect(paymentService.config('localhost')).rejects.toThrow(
      'Cart is missing a shipping address. Taxes cannot be calculated.',
    )
  })

  test('getConfig with getSession error', async () => {
    jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue({
      ...mockGetCartResult(),
      custom: {
        type: { typeId: 'type', id: 'briqpay-session-id' },
        fields: {
          [briqpaySessionIdCustomType.name]: 'abc123',
        },
      },
    })

    setupMockConfig({ mockClientKey: '', mockEnvironment: 'test' })

    // Simulate getSession throwing an error
    jest.spyOn(Briqpay, 'getSession').mockRejectedValueOnce(new Error('Failed to retrieve session'))

    const result = await paymentService.config('localhost')

    expect(result).toStrictEqual({
      briqpaySessionId: 'abc123',
      clientKey: '',
      environment: 'test',
      snippet: '<div>Briqpay</div>',
    })
  })

  test('getConfig with differing cart and session amounts', async () => {
    const cartWithDifferentAmount = {
      ...mockGetCartResult(),
      totalPrice: { centAmount: 130000, currencyCode: 'EUR' }, // Different amount
      custom: {
        type: { typeId: 'type', id: 'briqpay-session-id' },
        fields: {
          [briqpaySessionIdCustomType.name]: 'abc123',
        },
      },
    }

    const briqpaySession = {
      sessionId: 'abc123',
      data: {
        order: {
          amountIncVat: 120000, // Different amount here
        },
      },
    }

    // Mocking the necessary methods
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue(cartWithDifferentAmount as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(Briqpay, 'getSession').mockResolvedValue(briqpaySession as any)

    setupMockConfig({ mockClientKey: '', mockEnvironment: 'test' })

    const result = await paymentService.config('localhost')

    // Assertions
    expect(result).toStrictEqual({
      briqpaySessionId: 'abc123',
      clientKey: '',
      environment: 'test',
      snippet: '<div>Briqpay</div>',
    })
  })

  test('getConfig with matching cart and session amounts and one item', async () => {
    const matchingAmountIncVat = 119000
    const matchingAmountExVat = 100000
    const sessionId = 'abc123'
    const currencyCode = 'EUR'

    const mockCart: Cart = {
      ...JSON.parse(JSON.stringify(mockGetCartResult())),
      custom: {
        type: { typeId: 'type', id: 'briqpay-session-id' },
        fields: {
          [briqpaySessionIdCustomType.name]: sessionId,
        },
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mockCart as any).customLineItems = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mockCart as any).taxedPrice = {
      totalNet: {
        type: 'centPrecision',
        currencyCode: 'EUR',
        centAmount: 100000,
        fractionDigits: 2,
      },
      totalGross: {
        type: 'centPrecision',
        currencyCode: 'EUR',
        centAmount: 119000,
        fractionDigits: 2,
      },
      taxPortions: [
        {
          name: 'de-standard',
          amount: {
            type: 'centPrecision',
            currencyCode: 'EUR',
            centAmount: 19000,
            fractionDigits: 2,
          },
          rate: 0.19,
        },
      ],
      totalTax: {
        type: 'centPrecision',
        currencyCode: 'EUR',
        centAmount: 19000,
        fractionDigits: 2,
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mockCart as any).taxedPricePortions = [
      {
        name: 'de-standard',
        amount: {
          type: 'centPrecision',
          currencyCode: 'EUR',
          centAmount: 19000,
          fractionDigits: 2,
        },
        rate: 0.19,
      },
    ]

    // Mock getCart with matching totalPrice and a line item
    jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue(mockCart)

    setupMockConfig({ mockClientKey: '', mockEnvironment: 'test' })

    // Mock getSession with matching amount
    jest.spyOn(Briqpay, 'getSession').mockResolvedValue({
      sessionId,
      data: {
        order: {
          amountIncVat: matchingAmountIncVat,
          amountExVat: matchingAmountExVat,
          currency: currencyCode,
          cart: [
            {
              productType: ITEM_PRODUCT_TYPE.PHYSICAL,
              reference: mockCart.lineItems[0].productId,
              name: mockCart.lineItems[0].name.en,
              quantity: mockCart.lineItems[0].quantity,
              quantityUnit: 'pcs',
              unitPrice: matchingAmountExVat,
              taxRate: 1900,
            },
          ],
        },
      },
      htmlSnippet: '<div id="briqpay"></div>',
    })

    const result = await paymentService.config('localhost')

    expect(result).toStrictEqual({
      briqpaySessionId: sessionId,
      clientKey: '',
      environment: 'test',
      snippet: '<div>Briqpay</div>',
    })
  })

  test('getSupportedPaymentComponents', async () => {
    const result: ConfigResponse = await paymentService.getSupportedPaymentComponents()
    expect(result?.dropins).toHaveLength(1)
    expect(result?.dropins[0]?.type).toStrictEqual('briqpay')
    expect(result?.components).toHaveLength(0)
  })

  test('getStatus', async () => {
    // Mock the status handler to return a predefined response
    jest.spyOn(StatusHandler, 'statusHandler').mockReturnValue(() =>
      Promise.resolve({
        status: 200,
        body: {
          status: 'Partially Available',
          checks: [
            {
              name: 'CoCo Permissions',
              status: 'DOWN',
              message: 'CoCo Permissions are not available',
              details: {},
            },
            {
              name: 'Briqpay Payment API',
              status: 'UP',
              message: 'Briqpay Payment API is available',
              details: {},
            },
          ],
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      }),
    )

    const result: StatusResponse = await paymentService.status()

    expect(result?.status).toBeDefined()
    expect(result?.checks).toHaveLength(2)
    expect(result?.status).toStrictEqual('Partially Available')
    expect(result?.checks[0]?.name).toStrictEqual('CoCo Permissions')
    expect(result?.checks[0]?.status).toStrictEqual('DOWN')
    expect(result?.checks[0]?.details).toStrictEqual({})
    expect(result?.checks[0]?.message).toBeDefined()
    expect(result?.checks[1]?.name).toStrictEqual('Briqpay Payment API')
    expect(result?.checks[1]?.status).toStrictEqual('UP')
    expect(result?.checks[1]?.details).toBeDefined()
    expect(result?.checks[1]?.message).toBeDefined()
  })

  test('cancelPayment', async () => {
    const modifyPaymentOpts: ModifyPayment = {
      paymentId: 'dummy-paymentId',
      data: {
        actions: [
          {
            action: 'cancelPayment',
          },
        ],
      },
    }

    // Create a mock payment with an authorization transaction
    const mockPayment = {
      ...mockGetPaymentResult,
      amountPlanned: {
        type: 'centPrecision' as const,
        centAmount: 119000,
        currencyCode: 'EUR',
        fractionDigits: 2,
      },
      transactions: [
        {
          id: 'auth-transaction-id',
          type: 'Authorization',
          interactionId: 'test-session-id',
          state: 'Success',
          amount: {
            type: 'centPrecision' as const,
            centAmount: 119000,
            currencyCode: 'EUR',
            fractionDigits: 2,
          },
        },
      ],
    }

    // Mock the payment service methods
    jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockPayment)
    jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValue(mockUpdatePaymentResult)

    // Mock Briqpay cancel
    jest.spyOn(Briqpay, 'cancel').mockReturnValue(
      Promise.resolve({
        status: PaymentOutcome.APPROVED,
      }),
    )

    const result = await paymentService.modifyPayment(modifyPaymentOpts)
    expect(result?.outcome).toStrictEqual('approved')
  })

  test('cancelPayment should fail if payment has been captured', async () => {
    const modifyPaymentOpts: ModifyPayment = {
      paymentId: 'dummy-paymentId',
      data: {
        actions: [
          {
            action: 'cancelPayment',
          },
        ],
      },
    }

    // Create a mock payment with both authorization and capture transactions
    const mockPayment = {
      ...mockGetPaymentResult,
      amountPlanned: {
        type: 'centPrecision' as const,
        centAmount: 119000,
        currencyCode: 'EUR',
        fractionDigits: 2,
      },
      transactions: [
        {
          id: 'auth-transaction-id',
          type: 'Authorization',
          interactionId: 'test-session-id',
          state: 'Success',
          amount: {
            type: 'centPrecision' as const,
            centAmount: 119000,
            currencyCode: 'EUR',
            fractionDigits: 2,
          },
        },
        {
          id: 'capture-transaction-id',
          type: 'Charge',
          interactionId: 'test-capture-id',
          state: 'Success',
          amount: {
            type: 'centPrecision' as const,
            centAmount: 119000,
            currencyCode: 'EUR',
            fractionDigits: 2,
          },
        },
      ],
    }

    // Mock the payment service methods
    jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockPayment)

    const result = paymentService.modifyPayment(modifyPaymentOpts)
    await expect(result).rejects.toThrow('Cannot cancel a payment that has been captured')
  })

  test('cancelPayment should fail if no session ID found', async () => {
    const modifyPaymentOpts: ModifyPayment = {
      paymentId: 'dummy-paymentId',
      data: {
        actions: [
          {
            action: 'cancelPayment',
          },
        ],
      },
    }

    // Create a mock payment with no authorization transaction
    const mockPayment = {
      ...mockGetPaymentResult,
      amountPlanned: {
        type: 'centPrecision' as const,
        centAmount: 119000,
        currencyCode: 'EUR',
        fractionDigits: 2,
      },
      transactions: [],
    }

    // Mock the payment service methods
    jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockPayment)

    const result = paymentService.modifyPayment(modifyPaymentOpts)
    await expect(result).rejects.toThrow('Cannot find briqpay session')
  })

  test('capturePayment', async () => {
    const modifyPaymentOpts: ModifyPayment = {
      paymentId: 'dummy-paymentId',
      data: {
        actions: [
          {
            action: 'capturePayment',
            amount: {
              centAmount: 119000,
              currencyCode: 'EUR',
            },
          },
        ],
      },
    }

    // Create a mock payment with an authorization transaction
    const mockPayment = {
      ...mockGetPaymentResult,
      amountPlanned: {
        type: 'centPrecision' as const,
        centAmount: 119000,
        currencyCode: 'EUR',
        fractionDigits: 2,
      },
      transactions: [
        {
          id: 'auth-transaction-id',
          type: 'Authorization',
          interactionId: 'test-session-id',
          state: 'Success',
          amount: {
            type: 'centPrecision' as const,
            centAmount: 119000,
            currencyCode: 'EUR',
            fractionDigits: 2,
          },
        },
      ],
    }

    // Mock the payment service methods
    jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockPayment)
    jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValue(mockUpdatePaymentResult)

    // Mock the cart service
    jest.spyOn(paymentSDK.ctCartService, 'getCartByPaymentId').mockResolvedValue(mockGetCartResult())
    jest.spyOn(paymentSDK.ctCartService, 'getPaymentAmount').mockResolvedValue({
      centAmount: 119000,
      currencyCode: 'EUR',
      fractionDigits: 2,
    })

    // Mock Briqpay capture
    jest.spyOn(Briqpay, 'capture').mockReturnValue(
      Promise.resolve({
        captureId: '123',
        status: PaymentOutcome.APPROVED,
      }),
    )

    const result = await paymentService.modifyPayment(modifyPaymentOpts)
    expect(result?.outcome).toStrictEqual('approved')
  })

  test('capturePayment - pending', async () => {
    const modifyPaymentOpts: ModifyPayment = {
      paymentId: 'dummy-paymentId',
      data: {
        actions: [
          {
            action: 'capturePayment',
            amount: {
              centAmount: 119000,
              currencyCode: 'EUR',
            },
          },
        ],
      },
    }

    // Create a mock payment with an authorization transaction
    const mockPayment = {
      ...mockGetPaymentResult,
      amountPlanned: {
        type: 'centPrecision' as const,
        centAmount: 119000,
        currencyCode: 'EUR',
        fractionDigits: 2,
      },
      transactions: [
        {
          id: 'auth-transaction-id',
          type: 'Authorization',
          interactionId: 'test-session-id',
          state: 'Success',
          amount: {
            type: 'centPrecision' as const,
            centAmount: 119000,
            currencyCode: 'EUR',
            fractionDigits: 2,
          },
        },
      ],
    }

    // Mock the payment service methods
    jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockPayment)
    jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValue(mockUpdatePaymentResult)

    // Mock the cart service
    jest.spyOn(paymentSDK.ctCartService, 'getCartByPaymentId').mockResolvedValue(mockGetCartResult())
    jest.spyOn(paymentSDK.ctCartService, 'getPaymentAmount').mockResolvedValue({
      centAmount: 119000,
      currencyCode: 'EUR',
      fractionDigits: 2,
    })

    // Mock Briqpay capture
    jest.spyOn(Briqpay, 'capture').mockReturnValue(
      Promise.resolve({
        captureId: '123',
        status: PaymentOutcome.PENDING,
      }),
    )

    const result = await paymentService.modifyPayment(modifyPaymentOpts)
    expect(result?.outcome).toStrictEqual('received')
  })

  test('capturePayment - pending #2', async () => {
    const modifyPaymentOpts: ModifyPayment = {
      paymentId: 'dummy-paymentId',
      data: {
        actions: [
          {
            action: 'capturePayment',
            amount: {
              centAmount: 119000,
              currencyCode: 'EUR',
            },
          },
        ],
      },
    }

    // Create a mock payment with an authorization transaction
    const mockPayment = {
      ...mockGetPaymentResult,
      amountPlanned: {
        type: 'centPrecision' as const,
        centAmount: 119000,
        currencyCode: 'EUR',
        fractionDigits: 2,
      },
      transactions: [
        {
          id: 'auth-transaction-id',
          type: 'Authorization',
          interactionId: 'test-session-id',
          state: 'Success',
          amount: {
            type: 'centPrecision' as const,
            centAmount: 119000,
            currencyCode: 'EUR',
            fractionDigits: 2,
          },
        },
      ],
    }

    // Mock the payment service methods
    jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockPayment)
    jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValue(mockUpdatePaymentResult)

    // Mock the cart service
    jest.spyOn(paymentSDK.ctCartService, 'getCartByPaymentId').mockResolvedValue(mockGetCartResult())
    jest.spyOn(paymentSDK.ctCartService, 'getPaymentAmount').mockResolvedValue({
      centAmount: 119000,
      currencyCode: 'EUR',
      fractionDigits: 2,
    })

    // Mock Briqpay capture
    jest.spyOn(Briqpay, 'capture').mockReturnValue(
      Promise.resolve({
        captureId: '123',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    )

    const result = await paymentService.modifyPayment(modifyPaymentOpts)
    expect(result?.outcome).toStrictEqual('received')
  })

  test('capturePayment - rejected', async () => {
    const modifyPaymentOpts: ModifyPayment = {
      paymentId: 'dummy-paymentId',
      data: {
        actions: [
          {
            action: 'capturePayment',
            amount: {
              centAmount: 119000,
              currencyCode: 'EUR',
            },
          },
        ],
      },
    }

    // Create a mock payment with an authorization transaction
    const mockPayment = {
      ...mockGetPaymentResult,
      amountPlanned: {
        type: 'centPrecision' as const,
        centAmount: 119000,
        currencyCode: 'EUR',
        fractionDigits: 2,
      },
      transactions: [
        {
          id: 'auth-transaction-id',
          type: 'Authorization',
          interactionId: 'test-session-id',
          state: 'Success',
          amount: {
            type: 'centPrecision' as const,
            centAmount: 119000,
            currencyCode: 'EUR',
            fractionDigits: 2,
          },
        },
      ],
    }

    // Mock the payment service methods
    jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockPayment)
    jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValue(mockUpdatePaymentResult)

    // Mock the cart service
    jest.spyOn(paymentSDK.ctCartService, 'getCartByPaymentId').mockResolvedValue(mockGetCartResult())
    jest.spyOn(paymentSDK.ctCartService, 'getPaymentAmount').mockResolvedValue({
      centAmount: 119000,
      currencyCode: 'EUR',
      fractionDigits: 2,
    })

    // Mock Briqpay capture
    jest.spyOn(Briqpay, 'capture').mockReturnValue(
      Promise.resolve({
        captureId: '123',
        status: PaymentOutcome.REJECTED,
      }),
    )

    const result = await paymentService.modifyPayment(modifyPaymentOpts)
    expect(result?.outcome).toStrictEqual('rejected')
  })

  test('refundPayment', async () => {
    const modifyPaymentOpts: ModifyPayment = {
      paymentId: 'dummy-paymentId',
      data: {
        actions: [
          {
            action: 'refundPayment',
            amount: {
              centAmount: 119000,
              currencyCode: 'EUR',
            },
          },
        ],
      },
    }

    // Create a mock payment with both authorization and capture transactions
    const mockPayment = {
      ...mockGetPaymentResult,
      amountPlanned: {
        type: 'centPrecision' as const,
        centAmount: 119000,
        currencyCode: 'EUR',
        fractionDigits: 2,
      },
      transactions: [
        {
          id: 'auth-transaction-id',
          type: 'Authorization',
          interactionId: 'test-session-id',
          state: 'Success',
          amount: {
            type: 'centPrecision' as const,
            centAmount: 119000,
            currencyCode: 'EUR',
            fractionDigits: 2,
          },
        },
        {
          id: 'capture-transaction-id',
          type: 'Charge',
          interactionId: 'test-capture-id',
          state: 'Success',
          amount: {
            type: 'centPrecision' as const,
            centAmount: 119000,
            currencyCode: 'EUR',
            fractionDigits: 2,
          },
        },
      ],
    }

    // Mock the payment service methods
    jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockPayment)
    jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValue(mockUpdatePaymentResult)

    // Mock the cart service
    jest.spyOn(paymentSDK.ctCartService, 'getCartByPaymentId').mockResolvedValue(mockGetCartResult())
    jest.spyOn(paymentSDK.ctCartService, 'getPaymentAmount').mockResolvedValue({
      centAmount: 119000,
      currencyCode: 'EUR',
      fractionDigits: 2,
    })

    // Mock Briqpay refund
    jest.spyOn(Briqpay, 'refund').mockReturnValue(
      Promise.resolve({
        refundId: '123',
        status: PaymentOutcome.APPROVED,
      }),
    )

    const result = await paymentService.modifyPayment(modifyPaymentOpts)
    expect(result?.outcome).toStrictEqual('approved')
  })

  test('create payment successfully', async () => {
    const createPaymentOpts: CreatePaymentRequest = {
      data: {
        paymentMethod: {
          type: PaymentMethodType.BRIQPAY,
        },
        briqpaySessionId: 'abc123',
        paymentOutcome: PaymentOutcome.APPROVED,
      },
    }
    jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValue(Promise.resolve(mockGetCartResult()))
    jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockReturnValue(Promise.resolve(mockGetPaymentResult))
    jest.spyOn(DefaultCartService.prototype, 'addPayment').mockReturnValue(Promise.resolve(mockGetCartResult()))
    jest.spyOn(FastifyContext, 'getProcessorUrlFromContext').mockReturnValue('http://127.0.0.1')
    jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockReturnValue(Promise.resolve(mockGetPaymentResult))

    const result = await briqpayPaymentService.createPayment(createPaymentOpts)
    expect(result?.paymentReference).toStrictEqual('123456')
  })

  describe('handleTransaction', () => {
    test('should create the payment in CoCo and return it with a success state', async () => {
      const createPaymentOpts: TransactionDraftDTO = {
        cartId: 'dd4b7669-698c-4175-8e4c-bed178abfed3',
        paymentInterface: '42251cfc-0660-4ab3-80f6-c32829aa7a8b',
        amount: {
          centAmount: 1000,
          currencyCode: 'EUR',
        },
      }

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValueOnce(Promise.resolve(mockGetCartResult()))
      jest
        .spyOn(DefaultPaymentService.prototype, 'createPayment')
        .mockReturnValueOnce(Promise.resolve(mockGetPaymentResult))
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockReturnValueOnce(Promise.resolve(mockGetCartResult()))
      jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockUpdatePaymentResult))

      const resultPromise = briqpayPaymentService.handleTransaction(createPaymentOpts)
      expect(resultPromise).resolves.toStrictEqual({
        transactionStatus: {
          errors: [],
          state: 'Pending',
        },
      })
    })

    test('should create the payment in CoCo and return it with a failed state', async () => {
      const createPaymentOpts: TransactionDraftDTO = {
        cartId: 'dd4b7669-698c-4175-8e4c-bed178abfed3',
        paymentInterface: '42251cfc-0660-4ab3-80f6-c32829aa7a8b',
        amount: {
          centAmount: 10000,
          currencyCode: 'EUR',
        },
      }

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValueOnce(Promise.resolve(mockGetCartResult()))
      jest
        .spyOn(DefaultPaymentService.prototype, 'createPayment')
        .mockReturnValueOnce(Promise.resolve(mockGetPaymentResult))
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockReturnValueOnce(Promise.resolve(mockGetCartResult()))
      jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockUpdatePaymentResult))

      const resultPromise = briqpayPaymentService.handleTransaction(createPaymentOpts)

      expect(resultPromise).resolves.toStrictEqual({
        transactionStatus: {
          errors: [
            {
              code: 'PaymentRejected',
              message: `Payment '${mockGetPaymentResult.id}' has been rejected.`,
            },
          ],
          state: 'Failed',
        },
      })
    })
  })

  describe('reversePayment', () => {
    test('it should fail because there are no transactions to revert', async () => {
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'reversePayment',
            },
          ],
        },
      }

      // Mock payment with no transactions
      const mockPayment = {
        ...mockGetPaymentResult,
        amountPlanned: {
          type: 'centPrecision' as const,
          centAmount: 119000,
          currencyCode: 'EUR',
          fractionDigits: 2,
        },
        transactions: [],
      }

      // Mock the payment service methods
      jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockPayment)
      jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValue(mockUpdatePaymentResult)
      jest.spyOn(paymentSDK.ctPaymentService, 'hasTransactionInState').mockReturnValue(false)

      const result = paymentService.modifyPayment(modifyPaymentOpts)
      await expect(result).rejects.toThrow('There is no successful payment transaction to reverse.')
    })

    test('it should successfully revert transaction via refund when payment is captured', async () => {
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'reversePayment',
            },
          ],
        },
      }

      // Mock payment with successful charge transaction
      const mockPayment = {
        ...mockGetPaymentResult,
        amountPlanned: {
          type: 'centPrecision' as const,
          centAmount: 119000,
          currencyCode: 'EUR',
          fractionDigits: 2,
        },
        transactions: [
          {
            id: 'auth-transaction-id',
            type: 'Authorization',
            interactionId: 'test-session-id',
            state: 'Success',
            amount: {
              type: 'centPrecision' as const,
              centAmount: 119000,
              currencyCode: 'EUR',
              fractionDigits: 2,
            },
          },
          {
            id: 'charge-transaction-id',
            type: 'Charge',
            interactionId: 'test-capture-id',
            state: 'Success',
            amount: {
              type: 'centPrecision' as const,
              centAmount: 119000,
              currencyCode: 'EUR',
              fractionDigits: 2,
            },
          },
        ],
      }

      // Mock the payment service methods
      jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockPayment)
      jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValue(mockUpdatePaymentResult)

      // Mock hasTransactionInState to return true for charge and false for refund/cancel
      jest
        .spyOn(paymentSDK.ctPaymentService, 'hasTransactionInState')
        .mockImplementation(({ transactionType, states }) => {
          if (transactionType === 'Charge' && states.includes('Success')) return true
          if (transactionType === 'Refund' && states.includes('Success')) return false
          if (transactionType === 'CancelAuthorization' && states.includes('Success')) return false
          if (transactionType === 'Authorization' && states.includes('Success')) return true
          return false
        })

      // Mock the cart service
      jest.spyOn(paymentSDK.ctCartService, 'getCartByPaymentId').mockResolvedValue(mockGetCartResult())
      jest.spyOn(paymentSDK.ctCartService, 'getPaymentAmount').mockResolvedValue({
        centAmount: 119000,
        currencyCode: 'EUR',
        fractionDigits: 2,
      })

      // Mock Briqpay refund
      jest.spyOn(Briqpay, 'refund').mockReturnValue(
        Promise.resolve({
          refundId: '123',
          status: PaymentOutcome.APPROVED,
        }),
      )

      const result = await paymentService.modifyPayment(modifyPaymentOpts)
      expect(result?.outcome).toStrictEqual('approved')
    })

    test('it should successfully revert transaction via cancel when payment is authorized but not captured', async () => {
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'reversePayment',
            },
          ],
        },
      }

      // Mock payment with successful authorization but no charge
      const mockPayment = {
        ...mockGetPaymentResult,
        amountPlanned: {
          type: 'centPrecision' as const,
          centAmount: 119000,
          currencyCode: 'EUR',
          fractionDigits: 2,
        },
        transactions: [
          {
            id: 'auth-transaction-id',
            type: 'Authorization',
            interactionId: 'test-session-id',
            state: 'Success',
            amount: {
              type: 'centPrecision' as const,
              centAmount: 119000,
              currencyCode: 'EUR',
              fractionDigits: 2,
            },
          },
        ],
      }

      // Mock the payment service methods
      jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockPayment)
      jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValue(mockUpdatePaymentResult)

      // Mock hasTransactionInState to return true for authorization and false for charge/refund/cancel
      jest
        .spyOn(paymentSDK.ctPaymentService, 'hasTransactionInState')
        .mockImplementation(({ transactionType, states }) => {
          if (transactionType === 'Charge' && states.includes('Success')) return false
          if (transactionType === 'Refund' && states.includes('Success')) return false
          if (transactionType === 'CancelAuthorization' && states.includes('Success')) return false
          if (transactionType === 'Authorization' && states.includes('Success')) return true
          return false
        })

      // Mock Briqpay cancel
      jest.spyOn(Briqpay, 'cancel').mockReturnValue(
        Promise.resolve({
          status: PaymentOutcome.APPROVED,
        }),
      )

      const result = await paymentService.modifyPayment(modifyPaymentOpts)
      expect(result?.outcome).toStrictEqual('approved')
    })
  })

  test('calls handleOrderPending on ORDER_PENDING event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'PENDING',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING,
      },
    })

    expect(updateSpy).toHaveBeenCalledWith({
      id: 'payment-id-1',
      transaction: expect.objectContaining({
        type: 'Authorization',
        interactionId: 'abc123',
        state: 'Pending',
        amount: expect.objectContaining({
          centAmount: 119000,
          currencyCode: 'EUR',
        }),
      }),
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  test('calls handleOrderPending on ORDER_PENDING event with a success authorization already existing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [
              {
                id: 'transaction-id-1',
                type: 'Authorization',
                interactionId: 'abc123',
                state: 'Success',
                amount: {
                  centAmount: 10000,
                  currencyCode: 'EUR',
                  type: 'centPrecision',
                  fractionDigits: 2,
                },
                timestamp: '2024-01-01T00:00:00.000Z',
              },
            ],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'APPROVED',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING,
      },
    })

    expect(updateSpy).toHaveBeenCalledTimes(0)
  })

  test('calls handleOrderPending on ORDER_PENDING event with no payment existing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createSpy = jest.spyOn(paymentSDK.ctPaymentService, 'createPayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async () => {
      return []
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING,
      },
    })

    expect(createSpy).toHaveBeenCalledTimes(1)
  })

  test('calls handleOrderRejected on ORDER_REJECTED event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createSpy = jest.spyOn(paymentSDK.ctPaymentService, 'createPayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async () => {
      return []
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.ORDER_REJECTED,
      },
    })

    expect(createSpy).toHaveBeenCalledTimes(0)
  })

  test('calls handleOrderRejected on ORDER_CANCELLED event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createSpy = jest.spyOn(paymentSDK.ctPaymentService, 'createPayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async () => {
      return []
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.ORDER_CANCELLED,
      },
    })

    expect(createSpy).toHaveBeenCalledTimes(0)
  })

  test('calls handleOrderApproved on ORDER_APPROVED_NOT_CAPTURED event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'APPROVED',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED,
      },
    })

    expect(updateSpy).toHaveBeenCalledWith({
      id: 'payment-id-1',
      transaction: expect.objectContaining({
        type: 'Authorization',
        interactionId: 'abc123',
        state: 'Success',
        amount: expect.objectContaining({
          centAmount: 119000,
          currencyCode: 'EUR',
        }),
      }),
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  test('calls handleOrderApproved on ORDER_APPROVED_NOT_CAPTURED event with an authorization already pending', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [
              {
                id: 'transaction-id-1',
                type: 'Authorization',
                interactionId: 'abc123',
                state: 'Pending',
                amount: {
                  centAmount: 10000,
                  currencyCode: 'EUR',
                  type: 'centPrecision',
                  fractionDigits: 2,
                },
                timestamp: '2024-01-01T00:00:00.000Z',
              },
            ],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'APPROVED',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED,
      },
    })

    expect(updateSpy).toHaveBeenCalledWith({
      id: 'payment-id-1',
      transaction: expect.objectContaining({
        type: 'Authorization',
        interactionId: 'abc123',
        state: 'Success',
        amount: expect.objectContaining({
          centAmount: 119000,
          currencyCode: 'EUR',
        }),
      }),
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  test('calls handleOrderApproved on ORDER_APPROVED_NOT_CAPTURED event with an authorization already successful', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [
              {
                id: 'transaction-id-1',
                type: 'Authorization',
                interactionId: 'abc123',
                state: 'Success',
                amount: {
                  centAmount: 10000,
                  currencyCode: 'EUR',
                  type: 'centPrecision',
                  fractionDigits: 2,
                },
                timestamp: '2024-01-01T00:00:00.000Z',
              },
            ],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'APPROVED',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED,
      },
    })

    expect(updateSpy).toHaveBeenCalledTimes(0)
  })

  test('calls handleOrderApproved on ORDER_APPROVED_NOT_CAPTURED event with no payment existing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createSpy = jest.spyOn(paymentSDK.ctPaymentService, 'createPayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async () => {
      return []
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED,
      },
    })

    expect(createSpy).toHaveBeenCalledTimes(1)
  })

  test('calls handleCapturePending on capture PENDING event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'PENDING',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.PENDING,
        captureId: 'bcd123',
      },
    })

    expect(updateSpy).toHaveBeenCalledWith({
      id: 'payment-id-1',
      transaction: expect.objectContaining({
        type: 'Charge',
        interactionId: 'bcd123',
        state: 'Pending',
        amount: expect.objectContaining({
          centAmount: 119000,
          currencyCode: 'EUR',
        }),
      }),
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  test('calls handleCaptureApproved on capture APPROVED event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'APPROVED',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
        captureId: 'bcd123',
      },
    })

    expect(updateSpy).toHaveBeenCalledWith({
      id: 'payment-id-1',
      transaction: expect.objectContaining({
        type: 'Charge',
        interactionId: 'bcd123',
        state: 'Success',
        amount: expect.objectContaining({
          centAmount: 119000,
          currencyCode: 'EUR',
        }),
      }),
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  test('calls handleCaptureApproved on capture APPROVED event with pending authorization', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [
              {
                id: 'transaction-id-1',
                type: 'Authorization',
                interactionId: 'abc123',
                state: 'Pending',
                amount: {
                  centAmount: 10000,
                  currencyCode: 'EUR',
                  type: 'centPrecision',
                  fractionDigits: 2,
                },
                timestamp: '2024-01-01T00:00:00.000Z',
              },
            ],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'APPROVED',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
        captureId: 'bcd123',
      },
    })

    expect(updateSpy).toHaveBeenCalledTimes(2)
  })

  test('calls handleCapturePending on capture PENDING event with existing approved charge', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [
              {
                id: 'transaction-id-1',
                type: 'Charge',
                interactionId: 'bcd123',
                state: 'Success',
                amount: {
                  centAmount: 10000,
                  currencyCode: 'EUR',
                  type: 'centPrecision',
                  fractionDigits: 2,
                },
                timestamp: '2024-01-01T00:00:00.000Z',
              },
            ],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'APPROVED',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.PENDING,
        captureId: 'bcd123',
      },
    })

    expect(updateSpy).toHaveBeenCalledTimes(0)
  })

  test('calls handleCaptureRejected on capture REJECTED event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'FAILED',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.REJECTED,
        captureId: 'bcd123',
      },
    })

    expect(updateSpy).toHaveBeenCalledWith({
      id: 'payment-id-1',
      transaction: expect.objectContaining({
        type: 'Charge',
        interactionId: 'bcd123',
        state: 'Failure',
        amount: expect.objectContaining({
          centAmount: 119000,
          currencyCode: 'EUR',
        }),
      }),
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  test('calls handleRefundPending on refund PENDING event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'PENDING',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.PENDING,
        refundId: 'cde123',
      },
    })

    expect(updateSpy).toHaveBeenCalledWith({
      id: 'payment-id-1',
      transaction: expect.objectContaining({
        type: 'Refund',
        interactionId: 'cde123',
        state: 'Pending',
        amount: expect.objectContaining({
          centAmount: 119000,
          currencyCode: 'EUR',
        }),
      }),
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  test('calls handleRefundPending on refund PENDING event with already successful refund', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [
              {
                id: 'transaction-id-1',
                type: 'Refund',
                interactionId: 'cde123',
                state: 'Success',
                amount: {
                  centAmount: 10000,
                  currencyCode: 'EUR',
                  type: 'centPrecision',
                  fractionDigits: 2,
                },
                timestamp: '2024-01-01T00:00:00.000Z',
              },
            ],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'APPROVED',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.PENDING,
        refundId: 'cde123',
      },
    })

    expect(updateSpy).toHaveBeenCalledTimes(0)
  })

  test('calls handleRefundApproved on refund APPROVED event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'PENDING',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
        refundId: 'cde123',
      },
    })

    expect(updateSpy).toHaveBeenCalledWith({
      id: 'payment-id-1',
      transaction: expect.objectContaining({
        type: 'Refund',
        interactionId: 'cde123',
        state: 'Success',
        amount: expect.objectContaining({
          centAmount: 119000,
          currencyCode: 'EUR',
        }),
      }),
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  test('calls handleRefundRejected on refund REJECTED event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async ({ interfaceId }) => {
      if (interfaceId === 'abc123') {
        return [
          {
            id: 'payment-id-1',
            key: 'payment-key',
            interfaceId: '123',
            paymentMethodInfo: {
              method: 'Briqpay',
              paymentInterface: 'Briqpay',
            },
            amountPlanned: {
              centAmount: 10000,
              currencyCode: 'EUR',
              type: 'centPrecision',
              fractionDigits: 2,
            },
            transactions: [],
            interfaceInteractions: [],
            custom: undefined,
            version: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastModifiedAt: '2024-01-01T00:00:00.000Z',
            paymentStatus: {
              interfaceCode: 'FAILURE',
              interfaceText: 'Awaiting confirmation',
            },
          },
        ]
      }

      // Optional: simulate not found
      throw new Error('Not Found')
    })

    await briqpayPaymentService.processNotification({
      data: {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.REJECTED,
        refundId: 'cde123',
      },
    })

    expect(updateSpy).toHaveBeenCalledWith({
      id: 'payment-id-1',
      transaction: expect.objectContaining({
        type: 'Refund',
        interactionId: 'cde123',
        state: 'Failure',
        amount: expect.objectContaining({
          centAmount: 119000,
          currencyCode: 'EUR',
        }),
      }),
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  test('calls refundPayment() with no transaction', async () => {
    await expect(
      briqpayPaymentService.refundPayment({
        payment: {
          transactions: [],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).rejects.toThrow('Cannot find briqpay session')
  })

  test('calls refundPayment() with no capture', async () => {
    await expect(
      briqpayPaymentService.refundPayment({
        payment: {
          transactions: [
            {
              type: 'Authorization',
              interactionId: 'abc123',
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).rejects.toThrow('Must have a successful capture first')
  })

  test('calls refundPayment() with refund already done', async () => {
    await expect(
      briqpayPaymentService.refundPayment({
        payment: {
          transactions: [
            {
              type: 'Authorization',
              interactionId: 'abc123',
            },
            {
              type: 'Charge',
              state: 'Success',
              interactionId: 'bcd123',
            },
            {
              type: 'Refund',
              interactionId: 'cde123',
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).rejects.toThrow('Already refunded')
  })

  test('calls refundPayment() with incorrect amounts', async () => {
    jest.spyOn(paymentSDK.ctCartService, 'getCartByPaymentId').mockResolvedValueOnce({
      taxedPrice: {
        totalGross: {
          centAmount: 452243,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    await expect(
      briqpayPaymentService.refundPayment({
        payment: {
          transactions: [
            {
              type: 'Authorization',
              interactionId: 'abc123',
            },
            {
              type: 'Charge',
              state: 'Success',
              interactionId: 'bcd123',
            },
          ],
          amountPlanned: {
            centAmount: 123123,
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).rejects.toThrow('Commerce Tools does not support partial refunds towards all payment providers')
  })

  test('calls refundPayment() with pending authorization', async () => {
    jest.spyOn(paymentSDK.ctCartService, 'getCartByPaymentId').mockResolvedValueOnce({
      taxedPrice: {
        totalGross: {
          centAmount: 123123,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    await briqpayPaymentService.refundPayment({
      amount: {
        centAmount: 123123,
      },
      payment: {
        transactions: [
          {
            type: 'Authorization',
            state: 'Pending',
            interactionId: 'abc123',
          },
          {
            type: 'Charge',
            state: 'Success',
            interactionId: 'bcd123',
          },
        ],
        amountPlanned: {
          centAmount: 123123,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    expect(updateSpy).toHaveBeenCalledTimes(2)
  })
})
