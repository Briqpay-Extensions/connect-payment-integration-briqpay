import {
  SessionAlreadyCompletedError,
  SessionInitializationPendingError,
  SessionNotFoundError,
} from '../errors/briqpay-errors'

// Briqpay sends INVALID_DATA for a missing session, the same code as schema errors,
// so only the message identifies it. Drop this once SESSION_NOT_FOUND ships upstream.
const SESSION_MISSING_MESSAGE = 'Invalid sessionId - session does not exist.'

const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND'
const SESSION_ALREADY_COMPLETED = 'SESSION_ALREADY_COMPLETED'
const SESSION_INITIALIZATION_PENDING = 'SESSION_INITIALIZATION_PENDING'

type BriqpayErrorBody = { error?: { code?: string; message?: string } }

const parseErrorBody = (rawBody: string): BriqpayErrorBody | undefined => {
  try {
    return JSON.parse(rawBody) as BriqpayErrorBody
  } catch {
    return undefined
  }
}

/**
 * Maps a failed Briqpay session response to a typed error. Only a positive
 * identification maps to a typed error - an unparseable or unrecognised body must
 * stay generic, since callers recover from these and a false positive would
 * abandon or replace a session that is actually fine.
 */
export const mapBriqpaySessionError = (rawBody: string, sessionId: string): Error => {
  const parsed = parseErrorBody(rawBody)
  const code = parsed?.error?.code

  // Typed errors are Errorx-dispatched, so their message is served to the browser verbatim -
  // never include the raw upstream body (the call sites log it at ERROR level before throwing).
  if (code === SESSION_NOT_FOUND || parsed?.error?.message === SESSION_MISSING_MESSAGE) {
    return new SessionNotFoundError(`Briqpay session ${sessionId} no longer exists`)
  }

  if (code === SESSION_ALREADY_COMPLETED) {
    return new SessionAlreadyCompletedError(`Briqpay session ${sessionId} is already completed`)
  }

  if (code === SESSION_INITIALIZATION_PENDING) {
    return new SessionInitializationPendingError(`Briqpay session ${sessionId} is still initializing`)
  }

  return new Error(`Briqpay API error: ${rawBody}`)
}
