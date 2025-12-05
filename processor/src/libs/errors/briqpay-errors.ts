export class BriqpayError extends Error {
  public statusCode: number
  public code: string

  constructor(message: string, statusCode = 500, code = 'INTERNAL_SERVER_ERROR') {
    super(message)
    this.name = this.constructor.name
    this.statusCode = statusCode
    this.code = code
    Error.captureStackTrace(this, this.constructor)
  }
}

export class ConfigurationError extends BriqpayError {
  constructor(message: string) {
    super(message, 500, 'CONFIGURATION_ERROR')
  }
}

export class SessionError extends BriqpayError {
  constructor(message: string, statusCode = 500) {
    super(message, statusCode, 'SESSION_ERROR')
  }
}

export class ValidationError extends BriqpayError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR')
  }
}

export class UpstreamError extends BriqpayError {
  constructor(message: string, originalError?: unknown) {
    super(message, 502, 'UPSTREAM_ERROR')
    if (originalError instanceof Error) {
      this.cause = originalError
    }
  }
}
