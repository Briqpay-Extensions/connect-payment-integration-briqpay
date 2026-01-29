import { describe, test, expect, afterEach, jest, beforeEach } from '@jest/globals'
import crypto from 'crypto'
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
  ORDER_STATUS,
  TRANSACTION_STATUS,
  MediumBriqpayResponse,
} from '../src/services/types/briqpay-payment.type'
import { AbstractPaymentService } from '../src/services/abstract-payment.service'
import { BriqpayPaymentService } from '../src/services/briqpay-payment.service'
import * as FastifyContext from '../src/libs/fastify/context/context'
import * as StatusHandler from '@commercetools/connect-payments-sdk/dist/api/handlers/status.handler'
import {
  BRIQPAY_DECISION,
  BRIQPAY_REJECT_TYPE,
  BRIQPAY_WEBHOOK_EVENT,
  BRIQPAY_WEBHOOK_STATUS,
  NotificationRequestSchemaDTO,
  PaymentMethodType,
  PaymentOutcome,
} from '../src/dtos/briqpay-payment.dto'
import { apiRoot } from '../src/libs/commercetools/api-root'
import Briqpay from '../src/libs/briqpay/BriqpayService'
import { Cart } from '@commercetools/platform-sdk'
import { TransactionDraftDTO } from '../src/dtos/operations/transaction.dto'
import { briqpaySessionIdCustomType } from '../src/custom-types/custom-types'

/**
 * Helper to create a mock Briqpay session response with the appropriate moduleStatus.
 * The notification service reads actual status from moduleStatus (source of truth),
 * not from the webhook payload.
 */
const createMockBriqpaySession = (opts: {
  sessionId?: string
  orderStatus?: ORDER_STATUS
  captures?: Array<{ captureId: string; status: TRANSACTION_STATUS; amountIncVat: number; currency: string }>
  refunds?: Array<{ refundId: string; status: TRANSACTION_STATUS; amountIncVat: number; currency: string }>
}): MediumBriqpayResponse => {
  return {
    sessionId: opts.sessionId || 'abc123',
    htmlSnippet: '<div></div>',
    data: {
      order: {
        amountIncVat: 119000,
        currency: 'EUR',
        cart: [],
      },
      transactions: [],
      captures: opts.captures || [],
      refunds: opts.refunds || [],
    },
    moduleStatus: {
      payment: {
        uiStatus: 'completed',
        orderStatus: opts.orderStatus || ORDER_STATUS.ORDER_PENDING,
      },
    },
    captures: opts.captures || [],
    refunds: opts.refunds || [],
  }
}

const createSignedWebhookRequest = (data: NotificationRequestSchemaDTO) => {
  const secret = process.env.BRIQPAY_WEBHOOK_SECRET
  if (!secret) {
    throw new Error('BRIQPAY_WEBHOOK_SECRET must be set in tests')
  }

  const rawBody = JSON.stringify(data)
  // Unique past timestamp per call (within 5min tolerance) so replay cache does not trigger across tests
  const timestamp = (Date.now() - 15_000 - Math.floor(Math.random() * 50_000)).toString()
  const signedPayload = `${timestamp}.${rawBody}`
  const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('base64')
  const signatureHeader = `t=${timestamp},s1=${signature}`

  return { rawBody, signatureHeader }
}

// Mock actions module to avoid paymentSDK initialization issues
jest.mock('../src/connectors/actions', () => ({
  getBriqpayTypeKey: jest.fn().mockResolvedValue('briqpay-session-id'),
  clearBriqpayTypeKeyCache: jest.fn(),
}))

// Mock the apiRoot
jest.mock('../src/libs/commercetools/api-root', () => ({
  apiRoot: {
    carts: jest.fn().mockReturnValue({
      withId: jest.fn().mockReturnValue({
        post: jest.fn().mockReturnValue({
          execute: jest.fn().mockResolvedValue({ body: { version: 1 } } as unknown as never),
        }),
      }),
    }),
  },
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
    warn: jest.fn(),
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

    process.env.BRIQPAY_WEBHOOK_SECRET = 'test-secret'

    // Setup apiRoot mock
    ;(apiRoot.carts as jest.Mock<any>).mockReturnValue({
      withId: jest.fn<any>().mockReturnValue({
        post: jest.fn<any>().mockReturnValue({
          execute: jest.fn<any>().mockResolvedValue({ body: { version: 1 } }),
        }),
      }),
    })

    // Mock Briqpay service methods
    // Note: moduleStatus is the source of truth for status in notification processing
    // The webhook payload status is ignored - actual status is read from moduleStatus
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
      moduleStatus: {
        payment: {
          uiStatus: 'completed',
          orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
        },
      },
      captures: [],
      refunds: [],
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
    jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue(cartWithDifferentAmount as any)
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
    ;(mockCart as any).customLineItems = []
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
              unitPriceIncVat: matchingAmountIncVat,
              taxRate: 1900,
              totalAmount: matchingAmountIncVat,
              totalVatAmount: matchingAmountIncVat - matchingAmountExVat,
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
    expect(result?.dropins[0]?.type).toStrictEqual('embedded')
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
      cartId: 'explicit-cart-id',
      data: {
        paymentMethod: {
          type: PaymentMethodType.BRIQPAY,
        },
        briqpaySessionId: 'abc123',
        paymentOutcome: PaymentOutcome.APPROVED,
      },
    }
    const getCartSpy = jest
      .spyOn(paymentSDK.ctCartService, 'getCart')
      .mockReturnValue(Promise.resolve(mockGetCartResult()))
    jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockReturnValue(Promise.resolve(mockGetPaymentResult))
    jest.spyOn(DefaultCartService.prototype, 'addPayment').mockReturnValue(Promise.resolve(mockGetCartResult()))
    jest.spyOn(FastifyContext, 'getProcessorUrlFromContext').mockReturnValue('http://127.0.0.1')
    jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockReturnValue(Promise.resolve(mockGetPaymentResult))

    const result = await briqpayPaymentService.createPayment(createPaymentOpts)
    expect(result?.paymentReference).toStrictEqual('123456')
    expect(getCartSpy).toHaveBeenCalledWith({ id: 'explicit-cart-id' })
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
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return ORDER_PENDING status (source of truth)
    jest
      .spyOn(Briqpay, 'getSession')
      .mockResolvedValueOnce(createMockBriqpaySession({ orderStatus: ORDER_STATUS.ORDER_PENDING }))

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING,
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.PENDING,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

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
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return ORDER_PENDING status (source of truth)
    jest
      .spyOn(Briqpay, 'getSession')
      .mockResolvedValueOnce(createMockBriqpaySession({ orderStatus: ORDER_STATUS.ORDER_PENDING }))

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING,
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.PENDING,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

    expect(updateSpy).toHaveBeenCalledTimes(0)
  })

  test('calls handleOrderPending on ORDER_PENDING event with no payment existing', async () => {
    const createSpy = jest.spyOn(paymentSDK.ctPaymentService, 'createPayment').mockResolvedValueOnce({} as any)
    const getCartSpy = jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue(mockGetCartResult())

    // Mock Briqpay.getSession to return ORDER_PENDING status (source of truth)
    jest
      .spyOn(Briqpay, 'getSession')
      .mockResolvedValueOnce(createMockBriqpaySession({ orderStatus: ORDER_STATUS.ORDER_PENDING }))

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async () => {
      return []
    })

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      cartId: 'webhook-cart-id',
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING,
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.PENDING,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(getCartSpy).toHaveBeenCalledWith({ id: 'webhook-cart-id' })
  })

  test('calls handleOrderRejected on ORDER_REJECTED event', async () => {
    const createSpy = jest.spyOn(paymentSDK.ctPaymentService, 'createPayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return ORDER_REJECTED status (source of truth)
    jest
      .spyOn(Briqpay, 'getSession')
      .mockResolvedValueOnce(createMockBriqpaySession({ orderStatus: ORDER_STATUS.ORDER_REJECTED }))

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async () => {
      return []
    })

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.ORDER_REJECTED,
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.REJECTED,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

    expect(createSpy).toHaveBeenCalledTimes(0)
  })

  test('calls handleOrderRejected on ORDER_CANCELLED event', async () => {
    const createSpy = jest.spyOn(paymentSDK.ctPaymentService, 'createPayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return ORDER_CANCELLED status (source of truth)
    jest
      .spyOn(Briqpay, 'getSession')
      .mockResolvedValueOnce(createMockBriqpaySession({ orderStatus: ORDER_STATUS.ORDER_CANCELLED }))

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async () => {
      return []
    })

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.ORDER_CANCELLED,
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.CANCELLED,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

    expect(createSpy).toHaveBeenCalledTimes(0)
  })

  test('calls handleOrderApproved on ORDER_APPROVED_NOT_CAPTURED event', async () => {
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return ORDER_APPROVED_NOT_CAPTURED status (source of truth)
    jest
      .spyOn(Briqpay, 'getSession')
      .mockResolvedValueOnce(createMockBriqpaySession({ orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED }))

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED,
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.APPROVED,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

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
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return ORDER_APPROVED_NOT_CAPTURED status (source of truth)
    jest
      .spyOn(Briqpay, 'getSession')
      .mockResolvedValueOnce(createMockBriqpaySession({ orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED }))

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED,
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.APPROVED,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

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
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return ORDER_APPROVED_NOT_CAPTURED status (source of truth)
    jest
      .spyOn(Briqpay, 'getSession')
      .mockResolvedValueOnce(createMockBriqpaySession({ orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED }))

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED,
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.APPROVED,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

    expect(updateSpy).toHaveBeenCalledTimes(0)
  })

  test('calls handleOrderApproved on ORDER_APPROVED_NOT_CAPTURED event with no payment existing', async () => {
    const createSpy = jest.spyOn(paymentSDK.ctPaymentService, 'createPayment').mockResolvedValueOnce({} as any)
    const getCartSpy = jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue(mockGetCartResult())

    // Mock Briqpay.getSession to return ORDER_APPROVED_NOT_CAPTURED status (source of truth)
    jest
      .spyOn(Briqpay, 'getSession')
      .mockResolvedValueOnce(createMockBriqpaySession({ orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED }))

    jest.spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId').mockImplementation(async () => {
      return []
    })

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      cartId: 'webhook-cart-id-2',
      event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.ORDER_APPROVED_NOT_CAPTURED,
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.APPROVED,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(getCartSpy).toHaveBeenCalledWith({ id: 'webhook-cart-id-2' })
  })

  test('calls handleCapturePending on capture PENDING event', async () => {
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return capture with PENDING status (source of truth)
    jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
      createMockBriqpaySession({
        orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
        captures: [{ captureId: 'bcd123', status: TRANSACTION_STATUS.PENDING, amountIncVat: 119000, currency: 'EUR' }],
      }),
    )

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.PENDING,
      captureId: 'bcd123',
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.PENDING,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

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
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return capture with APPROVED status (source of truth)
    jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
      createMockBriqpaySession({
        orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
        captures: [{ captureId: 'bcd123', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 119000, currency: 'EUR' }],
      }),
    )

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
      captureId: 'bcd123',
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.APPROVED,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

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
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return capture with APPROVED status (source of truth)
    jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
      createMockBriqpaySession({
        orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
        captures: [{ captureId: 'bcd123', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 119000, currency: 'EUR' }],
      }),
    )

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
      captureId: 'bcd123',
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.APPROVED,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

    expect(updateSpy).toHaveBeenCalledTimes(2)
  })

  test('calls handleCapturePending on capture PENDING event with existing approved charge', async () => {
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return capture with PENDING status (source of truth)
    jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
      createMockBriqpaySession({
        orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
        captures: [{ captureId: 'bcd123', status: TRANSACTION_STATUS.PENDING, amountIncVat: 119000, currency: 'EUR' }],
      }),
    )

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.PENDING,
      captureId: 'bcd123',
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.PENDING,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

    expect(updateSpy).toHaveBeenCalledTimes(0)
  })

  test('calls handleCaptureRejected on capture REJECTED event', async () => {
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return capture with REJECTED status (source of truth)
    jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
      createMockBriqpaySession({
        orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
        captures: [{ captureId: 'bcd123', status: TRANSACTION_STATUS.REJECTED, amountIncVat: 119000, currency: 'EUR' }],
      }),
    )

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.REJECTED,
      captureId: 'bcd123',
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.REJECTED,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

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
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return refund with PENDING status (source of truth)
    // Note: refundId must match the one in the webhook payload
    jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
      createMockBriqpaySession({
        orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
        refunds: [{ refundId: 'cde123', status: TRANSACTION_STATUS.PENDING, amountIncVat: 119000, currency: 'EUR' }],
      }),
    )

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.PENDING,
      refundId: 'cde123',
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.PENDING,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

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
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return refund with PENDING status (source of truth)
    jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
      createMockBriqpaySession({
        orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
        refunds: [{ refundId: 'cde123', status: TRANSACTION_STATUS.PENDING, amountIncVat: 119000, currency: 'EUR' }],
      }),
    )

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.PENDING,
      refundId: 'cde123',
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.PENDING,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

    expect(updateSpy).toHaveBeenCalledTimes(0)
  })

  test('calls handleRefundApproved on refund APPROVED event', async () => {
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return refund with APPROVED status (source of truth)
    jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
      createMockBriqpaySession({
        orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
        refunds: [{ refundId: 'cde123', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 119000, currency: 'EUR' }],
      }),
    )

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
      refundId: 'cde123',
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.APPROVED,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

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
    const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

    // Mock Briqpay.getSession to return refund with REJECTED status (source of truth)
    jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
      createMockBriqpaySession({
        orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
        refunds: [{ refundId: 'cde123', status: TRANSACTION_STATUS.REJECTED, amountIncVat: 119000, currency: 'EUR' }],
      }),
    )

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

    const data: NotificationRequestSchemaDTO = {
      sessionId: 'abc123',
      event: BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS,
      status: BRIQPAY_WEBHOOK_STATUS.REJECTED,
      refundId: 'cde123',
      transaction: {
        transactionId: 'tx-1',
        status: TRANSACTION_STATUS.REJECTED,
        amountIncVat: 119000,
        currency: 'EUR',
      },
    }
    const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
    await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

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
    } as any)

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
    } as any)

    expect(updateSpy).toHaveBeenCalledTimes(2)
  })

  describe('makeDecision', () => {
    test('should successfully make a decision when session belongs to cart', async () => {
      jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue({
        ...mockGetCartResult(),
        custom: {
          type: { typeId: 'type', id: 'briqpay-session-id' },
          fields: {
            [briqpaySessionIdCustomType.name]: 'abc123',
          },
        },
      })

      jest.spyOn(Briqpay, 'makeDecision').mockResolvedValue({
        ok: true,
        status: 204,
      } as Response)

      const result = await briqpayPaymentService.makeDecision({
        sessionId: 'abc123',
        decision: BRIQPAY_DECISION.ALLOW,
      })

      expect(result).toEqual({
        success: true,
        decision: BRIQPAY_DECISION.ALLOW,
      })
    })

    test('should throw SessionError when cart has no Briqpay session', async () => {
      jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue({
        ...mockGetCartResult(),
        custom: undefined,
      })

      await expect(
        briqpayPaymentService.makeDecision({
          sessionId: 'abc123',
          decision: BRIQPAY_DECISION.ALLOW,
        }),
      ).rejects.toThrow('No Briqpay session found for this cart')
    })

    test('should throw SessionError when session ID does not match cart session', async () => {
      jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue({
        ...mockGetCartResult(),
        custom: {
          type: { typeId: 'type', id: 'briqpay-session-id' },
          fields: {
            [briqpaySessionIdCustomType.name]: 'different-session-id',
          },
        },
      })

      await expect(
        briqpayPaymentService.makeDecision({
          sessionId: 'abc123',
          decision: BRIQPAY_DECISION.ALLOW,
        }),
      ).rejects.toThrow('Session does not belong to this cart')
    })

    test('should throw UpstreamError when Briqpay API call fails', async () => {
      jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue({
        ...mockGetCartResult(),
        custom: {
          type: { typeId: 'type', id: 'briqpay-session-id' },
          fields: {
            [briqpaySessionIdCustomType.name]: 'abc123',
          },
        },
      })

      jest.spyOn(Briqpay, 'makeDecision').mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'Invalid decision',
      } as Response)

      await expect(
        briqpayPaymentService.makeDecision({
          sessionId: 'abc123',
          decision: BRIQPAY_DECISION.ALLOW,
        }),
      ).rejects.toThrow('Briqpay decision failed: 400 Bad Request')
    })

    test('should throw UpstreamError on unexpected error', async () => {
      jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue({
        ...mockGetCartResult(),
        custom: {
          type: { typeId: 'type', id: 'briqpay-session-id' },
          fields: {
            [briqpaySessionIdCustomType.name]: 'abc123',
          },
        },
      })

      jest.spyOn(Briqpay, 'makeDecision').mockRejectedValue(new Error('Network error'))

      await expect(
        briqpayPaymentService.makeDecision({
          sessionId: 'abc123',
          decision: BRIQPAY_DECISION.ALLOW,
        }),
      ).rejects.toThrow('Failed to process decision')
    })

    test('should pass rejection details to Briqpay', async () => {
      jest.spyOn(paymentSDK.ctCartService, 'getCart').mockResolvedValue({
        ...mockGetCartResult(),
        custom: {
          type: { typeId: 'type', id: 'briqpay-session-id' },
          fields: {
            [briqpaySessionIdCustomType.name]: 'abc123',
          },
        },
      })

      const makeDecisionSpy = jest.spyOn(Briqpay, 'makeDecision').mockResolvedValue({
        ok: true,
        status: 204,
      } as Response)

      await briqpayPaymentService.makeDecision({
        sessionId: 'abc123',
        decision: BRIQPAY_DECISION.REJECT,
        rejectionType: BRIQPAY_REJECT_TYPE.REJECT_WITH_ERROR,
        hardError: { message: 'Invalid address' },
        softErrors: [{ message: 'Missing phone' }],
      })

      expect(makeDecisionSpy).toHaveBeenCalledWith('abc123', {
        decision: BRIQPAY_DECISION.REJECT,
        rejectionType: BRIQPAY_REJECT_TYPE.REJECT_WITH_ERROR,
        hardError: { message: 'Invalid address' },
        softErrors: [{ message: 'Missing phone' }],
      })
    })
  })

  describe('config error handling', () => {
    test('should throw SessionError when session response is missing sessionId', async () => {
      setupMockConfig({ mockClientKey: '', mockEnvironment: 'test' })

      jest.spyOn(Briqpay, 'createSession').mockResolvedValue({
        htmlSnippet: '<div>Briqpay</div>',
        // sessionId is missing
      })

      await expect(paymentService.config('localhost')).rejects.toThrow(
        'Invalid Briqpay session response: missing sessionId',
      )
    })
  })

  describe('status with Briqpay API down', () => {
    test('should return DOWN status when Briqpay health check fails', async () => {
      jest.spyOn(StatusHandler, 'statusHandler').mockReturnValue(() =>
        Promise.resolve({
          status: 200,
          body: {
            status: 'Partially Available',
            checks: [
              {
                name: 'CoCo Permissions',
                status: 'UP',
                message: 'CoCo Permissions are available',
                details: {},
              },
              {
                name: 'Briqpay Payment API',
                status: 'DOWN',
                message: 'The Briqpay paymentAPI is down for some reason. Please check the logs for more details.',
                details: {
                  error: new Error('Connection refused'),
                },
              },
            ],
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          },
        }),
      )

      const result = await paymentService.status()

      expect(result?.status).toBe('Partially Available')
      expect(result?.checks).toHaveLength(2)
      expect(result?.checks[1]?.status).toBe('DOWN')
    })
  })

  describe('notification webhook validation', () => {
    test('should throw error when BRIQPAY_WEBHOOK_SECRET is missing', async () => {
      process.env.BRIQPAY_WEBHOOK_SECRET = ''

      await expect(
        briqpayPaymentService.processNotification({
          data: {
            sessionId: 'abc123',
            event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
            status: BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING,
          },
        }),
      ).rejects.toThrow('Webhooks disabled: BRIQPAY_WEBHOOK_SECRET missing')
    })

    test('should throw error when signature header or raw body is missing', async () => {
      process.env.BRIQPAY_WEBHOOK_SECRET = 'test-secret'

      await expect(
        briqpayPaymentService.processNotification({
          data: {
            sessionId: 'abc123',
            event: BRIQPAY_WEBHOOK_EVENT.ORDER_STATUS,
            status: BRIQPAY_WEBHOOK_STATUS.ORDER_PENDING,
          },
          signatureHeader: undefined,
          rawBody: undefined,
        }),
      ).rejects.toThrow('Webhook verification failed: Missing required signature data')
    })
  })

  describe('nested transaction payload support', () => {
    test('extracts transaction data from nested capture object', async () => {
      const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

      // Mock Briqpay.getSession to return capture with APPROVED status (source of truth)
      jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
        createMockBriqpaySession({
          orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
          captures: [
            { captureId: 'capture-123', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 5000, currency: 'EUR' },
          ],
        }),
      )

      jest
        .spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId')
        .mockImplementation(async ({ interfaceId }) => {
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
                  centAmount: 5000,
                  currencyCode: 'EUR',
                  type: 'centPrecision',
                  fractionDigits: 2,
                },
                transactions: [
                  {
                    id: 'auth-tx-1',
                    type: 'Authorization',
                    interactionId: 'abc123',
                    state: 'Success',
                    amount: {
                      centAmount: 5000,
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
          throw new Error('Not Found')
        })

      const data: NotificationRequestSchemaDTO = {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
        captureId: 'capture-123',
        // Top-level transaction is missing, but present inside capture
        capture: {
          captureId: 'capture-123',
          transaction: {
            transactionId: 'tx-capture-1',
            status: TRANSACTION_STATUS.APPROVED,
            amountIncVat: 5000,
            currency: 'EUR',
          },
        },
      }
      const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
      await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

      expect(updateSpy).toHaveBeenCalledWith({
        id: 'payment-id-1',
        transaction: expect.objectContaining({
          type: 'Charge',
          interactionId: 'capture-123',
          state: 'Success',
          amount: expect.objectContaining({
            centAmount: 5000,
            currencyCode: 'EUR',
          }),
        }),
      })
    })

    test('extracts transaction data from direct capture object', async () => {
      const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

      // Mock Briqpay.getSession to return capture with APPROVED status (source of truth)
      jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
        createMockBriqpaySession({
          orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
          captures: [
            { captureId: 'capture-123', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 5000, currency: 'EUR' },
          ],
        }),
      )

      jest
        .spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId')
        .mockImplementation(async ({ interfaceId }) => {
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
                  centAmount: 5000,
                  currencyCode: 'EUR',
                  type: 'centPrecision',
                  fractionDigits: 2,
                },
                transactions: [
                  {
                    id: 'auth-tx-1',
                    type: 'Authorization',
                    interactionId: 'abc123',
                    state: 'Success',
                    amount: {
                      centAmount: 5000,
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
          throw new Error('Not Found')
        })

      const data: NotificationRequestSchemaDTO = {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
        captureId: 'capture-123',
        capture: {
          captureId: 'capture-123',
          status: TRANSACTION_STATUS.APPROVED,
          amountIncVat: 5000,
          currency: 'EUR',
        },
      }
      const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
      await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

      expect(updateSpy).toHaveBeenCalledWith({
        id: 'payment-id-1',
        transaction: expect.objectContaining({
          type: 'Charge',
          interactionId: 'capture-123',
          state: 'Success',
          amount: expect.objectContaining({
            centAmount: 5000,
            currencyCode: 'EUR',
          }),
        }),
      })
    })

    test('extracts transaction data from nested refund object', async () => {
      const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

      // Mock Briqpay.getSession to return refund with APPROVED status
      jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
        createMockBriqpaySession({
          orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
          refunds: [
            { refundId: 'refund-123', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 2000, currency: 'EUR' },
          ],
        }),
      )

      jest
        .spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId')
        .mockImplementation(async ({ interfaceId }) => {
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
                  centAmount: 5000,
                  currencyCode: 'EUR',
                  type: 'centPrecision',
                  fractionDigits: 2,
                },
                transactions: [
                  {
                    id: 'auth-tx-1',
                    type: 'Authorization',
                    interactionId: 'abc123',
                    state: 'Success',
                    amount: {
                      centAmount: 5000,
                      currencyCode: 'EUR',
                      type: 'centPrecision',
                      fractionDigits: 2,
                    },
                    timestamp: '2024-01-01T00:00:00.000Z',
                  },
                  {
                    id: 'charge-tx-1',
                    type: 'Charge',
                    interactionId: 'capture-123',
                    state: 'Success',
                    amount: {
                      centAmount: 5000,
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
          throw new Error('Not Found')
        })

      const data: NotificationRequestSchemaDTO = {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
        refundId: 'refund-123',
        // Top-level transaction is missing, but present inside refund
        refund: {
          refundId: 'refund-123',
          transaction: {
            transactionId: 'tx-refund-1',
            status: TRANSACTION_STATUS.APPROVED,
            amountIncVat: 2000,
            currency: 'EUR',
          },
        },
      }
      const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
      await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

      expect(updateSpy).toHaveBeenCalledWith({
        id: 'payment-id-1',
        transaction: expect.objectContaining({
          type: 'Refund',
          interactionId: 'refund-123',
          state: 'Success',
          amount: expect.objectContaining({
            centAmount: 2000,
            currencyCode: 'EUR',
          }),
        }),
      })
    })

    test('extracts transaction data from direct refund object', async () => {
      const updateSpy = jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValueOnce({} as any)

      // Mock Briqpay.getSession to return refund with APPROVED status
      jest.spyOn(Briqpay, 'getSession').mockResolvedValueOnce(
        createMockBriqpaySession({
          orderStatus: ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
          refunds: [
            { refundId: 'refund-123', status: TRANSACTION_STATUS.APPROVED, amountIncVat: 2000, currency: 'EUR' },
          ],
        }),
      )

      jest
        .spyOn(paymentSDK.ctPaymentService, 'findPaymentsByInterfaceId')
        .mockImplementation(async ({ interfaceId }) => {
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
                  centAmount: 5000,
                  currencyCode: 'EUR',
                  type: 'centPrecision',
                  fractionDigits: 2,
                },
                transactions: [
                  {
                    id: 'auth-tx-1',
                    type: 'Authorization',
                    interactionId: 'abc123',
                    state: 'Success',
                    amount: {
                      centAmount: 5000,
                      currencyCode: 'EUR',
                      type: 'centPrecision',
                      fractionDigits: 2,
                    },
                    timestamp: '2024-01-01T00:00:00.000Z',
                  },
                  {
                    id: 'charge-tx-1',
                    type: 'Charge',
                    interactionId: 'capture-123',
                    state: 'Success',
                    amount: {
                      centAmount: 5000,
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
          throw new Error('Not Found')
        })

      const data: NotificationRequestSchemaDTO = {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.REFUND_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
        refundId: 'refund-123',
        refund: {
          refundId: 'refund-123',
          status: TRANSACTION_STATUS.APPROVED,
          amountIncVat: 2000,
          currency: 'EUR',
        },
      }
      const { rawBody, signatureHeader } = createSignedWebhookRequest(data)
      await briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })

      expect(updateSpy).toHaveBeenCalledWith({
        id: 'payment-id-1',
        transaction: expect.objectContaining({
          type: 'Refund',
          interactionId: 'refund-123',
          state: 'Success',
          amount: expect.objectContaining({
            centAmount: 2000,
            currencyCode: 'EUR',
          }),
        }),
      })
    })

    test('throws error if transaction data is missing entirely', async () => {
      process.env.BRIQPAY_WEBHOOK_SECRET = 'test-secret'

      const data: NotificationRequestSchemaDTO = {
        sessionId: 'abc123',
        event: BRIQPAY_WEBHOOK_EVENT.CAPTURE_STATUS,
        status: BRIQPAY_WEBHOOK_STATUS.APPROVED,
        captureId: 'capture-123',
        // No transaction anywhere
      }
      const { rawBody, signatureHeader } = createSignedWebhookRequest(data)

      await expect(briqpayPaymentService.processNotification({ data, rawBody, signatureHeader })).rejects.toThrow(
        'Webhook processing failed: Missing transaction data in payload',
      )
    })
  })
})
