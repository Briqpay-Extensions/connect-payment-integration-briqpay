import { Errorx } from '@commercetools/connect-payments-sdk'

// Must extend Errorx: the global fastify error handler dispatches on it,
// and anything else is served as a generic 500.
export class BriqpayError extends Errorx {
  constructor(message: string, statusCode = 500, code = 'INTERNAL_SERVER_ERROR', cause?: Error) {
    super({ message, code, httpErrorStatus: statusCode, cause })
    this.name = this.constructor.name
  }
}

export class SessionError extends BriqpayError {
  constructor(message: string, statusCode = 500) {
    super(message, statusCode, 'SESSION_ERROR')
  }
}

export class SessionNotFoundError extends BriqpayError {
  constructor(message: string) {
    super(message, 404, 'SESSION_NOT_FOUND')
  }
}

// Briqpay refuses to update a completed session. Never replace one: it may hold a
// live authorization, and a replacement would risk double-charging the buyer.
export class SessionAlreadyCompletedError extends BriqpayError {
  constructor(message: string) {
    super(message, 409, 'SESSION_ALREADY_COMPLETED')
  }
}

export class SessionInitializationPendingError extends BriqpayError {
  constructor(message: string) {
    super(message, 409, 'SESSION_INITIALIZATION_PENDING')
  }
}

export class ValidationError extends BriqpayError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR')
  }
}

export class UpstreamError extends BriqpayError {
  constructor(message: string, originalError?: unknown) {
    super(message, 502, 'UPSTREAM_ERROR', originalError instanceof Error ? originalError : undefined)
  }
}
