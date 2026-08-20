import { describe, expect, test } from '@jest/globals'
import { mapBriqpaySessionError } from '../../../src/libs/briqpay/session-error-mapping'
import {
  SessionAlreadyCompletedError,
  SessionInitializationPendingError,
  SessionNotFoundError,
} from '../../../src/libs/errors/briqpay-errors'

const body = (error: Record<string, string>) => JSON.stringify({ error })

describe('mapBriqpaySessionError', () => {
  test('maps the current missing-session message, which is all that identifies it today', () => {
    const error = mapBriqpaySessionError(
      body({ code: 'INVALID_DATA', message: 'Invalid sessionId - session does not exist.' }),
      'sess-1',
    )

    expect(error).toBeInstanceOf(SessionNotFoundError)
  })

  test('maps the dedicated code once Briqpay starts sending it', () => {
    const error = mapBriqpaySessionError(body({ code: 'SESSION_NOT_FOUND', message: 'gone' }), 'sess-1')

    expect(error).toBeInstanceOf(SessionNotFoundError)
  })

  test('maps an already-completed session', () => {
    const error = mapBriqpaySessionError(
      body({ code: 'SESSION_ALREADY_COMPLETED', message: 'This session is already completed' }),
      'sess-1',
    )

    expect(error).toBeInstanceOf(SessionAlreadyCompletedError)
  })

  test('maps a session that is still initializing', () => {
    const error = mapBriqpaySessionError(
      body({ code: 'SESSION_INITIALIZATION_PENDING', message: 'Try again in a few seconds' }),
      'sess-1',
    )

    expect(error).toBeInstanceOf(SessionInitializationPendingError)
  })

  test('typed errors never include the raw upstream body, since their message is served to the browser', () => {
    const upstreamBody = body({ code: 'SESSION_ALREADY_COMPLETED', message: 'internal detail from Briqpay' })

    const error = mapBriqpaySessionError(upstreamBody, 'sess-1')

    expect(error.message).not.toContain('internal detail from Briqpay')
    expect(error.message).toContain('sess-1')
  })

  test('leaves a schema validation error generic, since it shares INVALID_DATA', () => {
    // Recovering from this as "session gone" would replace a session that is fine.
    const error = mapBriqpaySessionError(
      body({ code: 'INVALID_DATA', message: 'data.order should be object' }),
      'sess-1',
    )

    expect(error).not.toBeInstanceOf(SessionNotFoundError)
    expect(error.message).toContain('Briqpay API error')
  })

  test('leaves an unparseable body generic and keeps its raw text', () => {
    const error = mapBriqpaySessionError('<html>502 Bad Gateway</html>', 'sess-1')

    expect(error).not.toBeInstanceOf(SessionNotFoundError)
    expect(error.message).toContain('502 Bad Gateway')
  })
})
