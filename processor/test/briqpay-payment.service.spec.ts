import { describe, test, expect, afterEach, jest, beforeEach } from '@jest/globals'
import { ConfigResponse, ModifyPayment, StatusResponse } from '../src/services/types/operation.type'
import { paymentSDK } from '../src/payment-sdk'
import { DefaultPaymentService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-payment.service'
import { DefaultCartService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-cart.service'
import { mockGetPaymentResult, mockUpdatePaymentResult } from './utils/mock-payment-results'
import { mockGetCartResult } from './utils/mock-cart-data'
import * as Config from '../src/config/config'
import { CreatePaymentRequest, BriqpayPaymentServiceOptions } from '../src/services/types/briqpay-payment.type'
import { AbstractPaymentService } from '../src/services/abstract-payment.service'
import { BriqpayPaymentService } from '../src/services/briqpay-payment.service'
import * as FastifyContext from '../src/libs/fastify/context/context'
import * as StatusHandler from '@commercetools/connect-payments-sdk/dist/api/handlers/status.handler'
import { PaymentMethodType, PaymentOutcome } from '../src/dtos/briqpay-payment.dto'
import { TransactionDraftDTO } from '../src/dtos/operations/transaction.dto'
import Briqpay from '../src/libs/briqpay/BriqpayService'
import { ByProjectKeyCartsRequestBuilder } from '@commercetools/platform-sdk'

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
      },
    },
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
      sessionId: '123',
      status: PaymentOutcome.APPROVED,
      htmlSnippet: '<div>Briqpay</div>',
      data: {
        order: {
          amountIncVat: 120000,
          currency: 'GBP',
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
      centAmount: 120000,
      currencyCode: 'GBP',
      fractionDigits: 2,
    })
    jest.spyOn(paymentSDK.ctPaymentService, 'getPayment').mockResolvedValue(mockGetPaymentResult)
    jest.spyOn(paymentSDK.ctPaymentService, 'createPayment').mockResolvedValue(mockGetPaymentResult)
    jest.spyOn(paymentSDK.ctPaymentService, 'updatePayment').mockResolvedValue(mockUpdatePaymentResult)
    jest
      .spyOn(paymentSDK.ctAPI.client, 'execute' as keyof typeof paymentSDK.ctAPI.client)
      .mockResolvedValue({ body: {} } as unknown as never)

    // Mock the carts API
    paymentSDK.ctAPI.client.carts = jest.fn().mockReturnValue({
      withId: jest.fn().mockReturnValue({
        post: jest.fn().mockReturnValue({
          execute: jest.fn(),
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
        sessionId: '123',
        status: PaymentOutcome.APPROVED,
      }),
    )

    const result: ConfigResponse = await paymentService.config()

    // Assertions can remain the same or be adapted based on the abstracted access
    expect(result?.clientKey).toStrictEqual('')
    expect(result?.environment).toStrictEqual('test')
  })

  test('getSupportedPaymentComponents', async () => {
    const result: ConfigResponse = await paymentService.getSupportedPaymentComponents()
    expect(result?.components).toHaveLength(1)
    expect(result?.components[0]?.type).toStrictEqual('briqpay')
    expect(result?.dropins).toHaveLength(0)
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
        centAmount: 150000,
        currencyCode: 'USD',
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
            centAmount: 150000,
            currencyCode: 'USD',
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
        centAmount: 150000,
        currencyCode: 'USD',
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
            centAmount: 150000,
            currencyCode: 'USD',
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
            centAmount: 150000,
            currencyCode: 'USD',
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
        centAmount: 150000,
        currencyCode: 'USD',
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
              centAmount: 150000,
              currencyCode: 'USD',
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
        centAmount: 150000,
        currencyCode: 'USD',
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
            centAmount: 150000,
            currencyCode: 'USD',
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
      centAmount: 150000,
      currencyCode: 'USD',
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

  test('refundPayment', async () => {
    const modifyPaymentOpts: ModifyPayment = {
      paymentId: 'dummy-paymentId',
      data: {
        actions: [
          {
            action: 'refundPayment',
            amount: {
              centAmount: 150000,
              currencyCode: 'USD',
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
        centAmount: 150000,
        currencyCode: 'USD',
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
            centAmount: 150000,
            currencyCode: 'USD',
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
            centAmount: 150000,
            currencyCode: 'USD',
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
      centAmount: 150000,
      currencyCode: 'USD',
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
        briqpaySessionId: '123',
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
          centAmount: 150000,
          currencyCode: 'USD',
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
          centAmount: 150000,
          currencyCode: 'USD',
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
              centAmount: 150000,
              currencyCode: 'USD',
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
              centAmount: 150000,
              currencyCode: 'USD',
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
        centAmount: 150000,
        currencyCode: 'USD',
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
          centAmount: 150000,
          currencyCode: 'USD',
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
              centAmount: 150000,
              currencyCode: 'USD',
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
})
