/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, test, expect, afterEach, jest, beforeEach } from '@jest/globals'
import { SessionAuthentication, SessionPrincipal } from '@commercetools/connect-payments-sdk'
import * as Context from '../../../../src/libs/fastify/context/context'
import { requestContext } from '@fastify/request-context'

// Mock the request context
jest.mock('@fastify/request-context', () => ({
  requestContext: {
    get: jest.fn<any>(),
    set: jest.fn<any>(),
  },
  fastifyRequestContext: {},
}))

describe('context', () => {
  const sessionId: string = '123456-123456-123456-123456'
  const principal: SessionPrincipal = {
    cartId: '123456',
    allowedPaymentMethods: [],
    processorUrl: 'http://127.0.0.1',
    paymentInterface: 'dummyPaymentInterface',
    merchantReturnUrl: 'https://merchant.return.url',
    futureOrderNumber: 'order-123',
  }

  const mockSessionAuthentication: SessionAuthentication = new SessionAuthentication(sessionId, principal)

  beforeEach(() => {
    jest.setTimeout(10000)
    jest.resetAllMocks()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('getCtSessionIdFromContext', async () => {
    const mockRequestContext = {
      authentication: mockSessionAuthentication,
    }
    jest.spyOn(Context, 'getRequestContext').mockReturnValue(mockRequestContext)
    const result = Context.getCtSessionIdFromContext()
    expect(result).toStrictEqual(sessionId)
  })

  test('getAllowedPaymentMethodsFromContext', async () => {
    const mockRequestContext = {
      authentication: mockSessionAuthentication,
    }
    jest.spyOn(Context, 'getRequestContext').mockReturnValue(mockRequestContext)
    const result = Context.getAllowedPaymentMethodsFromContext()
    expect(result).toHaveLength(0)
  })

  test('getCartIdFromContext', async () => {
    const mockRequestContext = {
      authentication: mockSessionAuthentication,
    }
    jest.spyOn(Context, 'getRequestContext').mockReturnValue(mockRequestContext)
    const result = Context.getCartIdFromContext()
    expect(result).toStrictEqual('123456')
  })

  test('getMerchantReturnUrlFromContext', async () => {
    const mockRequestContext = {
      authentication: mockSessionAuthentication,
    }
    jest.spyOn(Context, 'getRequestContext').mockReturnValue(mockRequestContext)
    const result = Context.getMerchantReturnUrlFromContext()
    expect(result).toStrictEqual('https://merchant.return.url')
  })

  test('getProcessorUrlFromContext', async () => {
    const mockRequestContext = {
      authentication: mockSessionAuthentication,
    }
    jest.spyOn(Context, 'getRequestContext').mockReturnValue(mockRequestContext)
    const result = Context.getProcessorUrlFromContext()
    expect(result).toStrictEqual('http://127.0.0.1')
  })

  test('getFutureOrderNumberFromContext', async () => {
    const mockRequestContext = {
      authentication: mockSessionAuthentication,
    }
    jest.spyOn(Context, 'getRequestContext').mockReturnValue(mockRequestContext)
    const result = Context.getFutureOrderNumberFromContext()
    expect(result).toStrictEqual('order-123')
  })

  test('getPaymentInterfaceFromContext', async () => {
    const mockRequestContext = {
      authentication: mockSessionAuthentication,
    }
    jest.spyOn(Context, 'getRequestContext').mockReturnValue(mockRequestContext)
    const result = Context.getPaymentInterfaceFromContext()
    expect(result).toStrictEqual('dummyPaymentInterface')
  })

  test('setRequestContext should set context', () => {
    const contextData: Context.ContextData = {
      correlationId: 'test-correlation-id',
      requestId: 'test-request-id',
      path: '/test',
      authentication: mockSessionAuthentication,
    }

    Context.setRequestContext(contextData)

    expect((requestContext as any).set).toHaveBeenCalledWith('request', contextData)
  })

  test('updateRequestContext should merge with existing context', () => {
    const existingContext = {
      correlationId: 'existing-correlation-id',
      requestId: 'existing-request-id',
    }
    ;(requestContext.get as jest.Mock<any>).mockReturnValue(existingContext)

    const updateData = {
      path: '/new-path',
    }

    Context.updateRequestContext(updateData)

    expect((requestContext as any).set).toHaveBeenCalledWith('request', {
      ...existingContext,
      ...updateData,
    })
  })

  test('getRequestContext should return empty object when no context exists', () => {
    ;(requestContext.get as jest.Mock<any>).mockReturnValue(undefined)

    const result = Context.getRequestContext()

    expect(result).toEqual({})
  })
})
