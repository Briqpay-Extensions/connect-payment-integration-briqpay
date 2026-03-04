import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'

// Mock the payment SDK logger
jest.mock('../../src/payment-sdk', () => ({
  appLogger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}))

import { validateEnvironment, EnvValidationError, logEnvironmentStatus } from '../../src/config/env-validation'
import { appLogger } from '../../src/payment-sdk'

const mockInfo = jest.mocked(appLogger.info)

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
}

describe('env-validation', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...REQUIRED_ENV }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('BRIQPAY_EXTERNAL_WEBHOOK_URL', () => {
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

  describe('missing required variables', () => {
    it('should throw EnvValidationError when a required var is missing', () => {
      delete process.env.CTP_PROJECT_KEY
      expect(() => validateEnvironment()).toThrow(EnvValidationError)
      try {
        validateEnvironment()
      } catch (e) {
        const err = e as EnvValidationError
        expect(err.missingVars).toContain('CTP_PROJECT_KEY')
      }
    })

    it('should throw when a required var is empty string', () => {
      process.env.CTP_PROJECT_KEY = '   '
      expect(() => validateEnvironment()).toThrow(EnvValidationError)
    })

    it('should report multiple missing vars', () => {
      delete process.env.CTP_PROJECT_KEY
      delete process.env.CTP_CLIENT_ID
      try {
        validateEnvironment()
      } catch (e) {
        const err = e as EnvValidationError
        expect(err.missingVars).toContain('CTP_PROJECT_KEY')
        expect(err.missingVars).toContain('CTP_CLIENT_ID')
        expect(err.message).toContain('Missing required environment variables')
      }
    })
  })

  describe('invalid required variables', () => {
    it('should fail when BRIQPAY_BASE_URL is not HTTPS', () => {
      process.env.BRIQPAY_BASE_URL = 'http://api.briqpay.com'
      try {
        validateEnvironment()
      } catch (e) {
        const err = e as EnvValidationError
        expect(err.invalidVars.some((v) => v.includes('BRIQPAY_BASE_URL'))).toBe(true)
        expect(err.message).toContain('Invalid environment variables')
      }
    })

    it('should fail when BRIQPAY_TERMS_URL is not HTTPS', () => {
      process.env.BRIQPAY_TERMS_URL = 'http://terms.example.com'
      expect(() => validateEnvironment()).toThrow(EnvValidationError)
    })
  })

  describe('ALLOWED_ORIGINS validation (isSecureOrLocalUrl)', () => {
    it('should pass with HTTPS origins', () => {
      process.env.ALLOWED_ORIGINS = 'https://example.com,https://other.com'
      expect(() => validateEnvironment()).not.toThrow()
    })

    it('should pass with localhost HTTP origins', () => {
      process.env.ALLOWED_ORIGINS = 'http://localhost:3000'
      expect(() => validateEnvironment()).not.toThrow()
    })

    it('should pass with 127.0.0.1 HTTP origins', () => {
      process.env.ALLOWED_ORIGINS = 'http://127.0.0.1:8080'
      expect(() => validateEnvironment()).not.toThrow()
    })

    it('should pass with 0.0.0.0 HTTP origins', () => {
      process.env.ALLOWED_ORIGINS = 'http://0.0.0.0:3000'
      expect(() => validateEnvironment()).not.toThrow()
    })

    it('should pass with IPv6 loopback HTTP origins', () => {
      process.env.ALLOWED_ORIGINS = 'http://[::1]:3000'
      expect(() => validateEnvironment()).not.toThrow()
    })

    it('should pass with private network IP (10.x.x.x)', () => {
      process.env.ALLOWED_ORIGINS = 'http://10.0.0.1:3000'
      expect(() => validateEnvironment()).not.toThrow()
    })

    it('should pass with private network IP (172.16.x.x)', () => {
      process.env.ALLOWED_ORIGINS = 'http://172.16.0.1:8080'
      expect(() => validateEnvironment()).not.toThrow()
    })

    it('should pass with private network IP (192.168.x.x)', () => {
      process.env.ALLOWED_ORIGINS = 'http://192.168.1.1'
      expect(() => validateEnvironment()).not.toThrow()
    })

    it('should fail with non-local HTTP origin', () => {
      process.env.ALLOWED_ORIGINS = 'http://shadywebsite.com'
      expect(() => validateEnvironment()).toThrow(EnvValidationError)
    })

    it('should fail with non-HTTP/HTTPS origin', () => {
      process.env.ALLOWED_ORIGINS = 'ftp://example.com'
      expect(() => validateEnvironment()).toThrow(EnvValidationError)
    })

    it('should pass with HTTPS wildcard pattern', () => {
      process.env.ALLOWED_ORIGINS = 'https://*.preview.example.com'
      expect(() => validateEnvironment()).not.toThrow()
    })

    it('should fail with HTTP wildcard pattern', () => {
      process.env.ALLOWED_ORIGINS = 'http://*.preview.example.com'
      expect(() => validateEnvironment()).toThrow(EnvValidationError)
    })

    it('should fail when one of multiple origins is invalid', () => {
      process.env.ALLOWED_ORIGINS = 'https://good.com,http://bad.com'
      expect(() => validateEnvironment()).toThrow(EnvValidationError)
    })
  })

  describe('logEnvironmentStatus', () => {
    it('should log environment status with sensitive values masked', () => {
      logEnvironmentStatus()
      expect(mockInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          CTP_PROJECT_KEY: 'test-project',
          CTP_CLIENT_ID: '[SET]',
          CTP_CLIENT_SECRET: '[SET]',
        }),
        'Environment configuration:',
      )
    })

    it('should log [NOT SET] for missing optional vars', () => {
      logEnvironmentStatus()
      expect(mockInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          ALLOWED_ORIGINS: '[NOT SET]',
        }),
        'Environment configuration:',
      )
    })

    it('should log [NOT SET] for missing sensitive vars', () => {
      delete process.env.BRIQPAY_SECRET
      logEnvironmentStatus()
      expect(mockInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          BRIQPAY_SECRET: '[NOT SET]',
        }),
        'Environment configuration:',
      )
    })
  })
})
