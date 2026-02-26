import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { validateEnvironment, EnvValidationError } from '../../src/config/env-validation'

// Mock the payment SDK logger
jest.mock('../../src/payment-sdk', () => ({
  appLogger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}))

// Minimal required env vars for validation to pass
const REQUIRED_ENV: Record<string, string> = {
  CTP_PROJECT_KEY: 'test-project',
  CTP_CLIENT_ID: 'test-client-id',
  CTP_CLIENT_SECRET: 'test-client-secret',
  CTP_AUTH_URL: 'https://auth.example.com',
  CTP_API_URL: 'https://api.example.com',
  CTP_JWKS_URL: 'https://jwks.example.com',
  CTP_JWT_ISSUER: 'https://issuer.example.com',
  BRIQPAY_USERNAME: 'test-user',
  BRIQPAY_SECRET: 'test-secret',
  BRIQPAY_BASE_URL: 'https://api.briqpay.com',
  BRIQPAY_WEBHOOK_SECRET: 'webhook-secret',
  BRIQPAY_TERMS_URL: 'https://terms.example.com',
  BRIQPAY_CONFIRMATION_URL: 'https://confirm.example.com',
}

describe('env-validation: BRIQPAY_EXTERNAL_WEBHOOK_URL', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...REQUIRED_ENV }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('should pass validation when BRIQPAY_EXTERNAL_WEBHOOK_URL is not set', () => {
    expect(() => validateEnvironment()).not.toThrow()
  })

  it('should pass validation when BRIQPAY_EXTERNAL_WEBHOOK_URL is a valid HTTPS URL', () => {
    process.env.BRIQPAY_EXTERNAL_WEBHOOK_URL = 'https://merchant.example.com/webhooks'
    expect(() => validateEnvironment()).not.toThrow()
  })

  it('should fail validation when BRIQPAY_EXTERNAL_WEBHOOK_URL is HTTP (not local)', () => {
    process.env.BRIQPAY_EXTERNAL_WEBHOOK_URL = 'http://merchant.example.com/webhooks'
    expect(() => validateEnvironment()).toThrow(EnvValidationError)
  })

  it('should fail validation when BRIQPAY_EXTERNAL_WEBHOOK_URL is not a URL', () => {
    process.env.BRIQPAY_EXTERNAL_WEBHOOK_URL = 'not-a-url'
    expect(() => validateEnvironment()).toThrow(EnvValidationError)
  })
})
