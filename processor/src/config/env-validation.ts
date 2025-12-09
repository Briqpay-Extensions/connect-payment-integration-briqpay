/**
 * Environment variable validation for security-critical configuration.
 * This module ensures all required environment variables are present
 * and properly formatted before the application starts.
 *
 * SECURITY: Fail fast if critical configuration is missing to prevent
 * the application from running in an insecure state.
 */

/**
 * SECURITY: Validates that a URL is either HTTPS or a local development HTTP URL.
 * Local development URLs are allowed for testing purposes only.
 * This prevents allowing arbitrary HTTP origins like http://shadywebsite.com
 */
function isSecureOrLocalUrl(url: string): boolean {
  // HTTPS is always allowed
  if (url.startsWith('https://')) {
    return true
  }

  // HTTP is only allowed for local development addresses
  if (url.startsWith('http://')) {
    const localPatterns = [
      'http://localhost',
      'http://localhost:',
      'http://127.0.0.1',
      'http://127.0.0.1:',
      'http://0.0.0.0',
      'http://0.0.0.0:',
      'http://[::1]',
      'http://[::1]:',
    ]

    if (localPatterns.some((pattern) => url.startsWith(pattern))) {
      return true
    }

    // Also allow private network IPs for local development (RFC 1918)
    // 10.0.0.0 - 10.255.255.255, 172.16.0.0 - 172.31.255.255, 192.168.0.0 - 192.168.255.255
    const privateNetworkRegex =
      /^http:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?(\/.*)?$/
    return privateNetworkRegex.test(url)
  }

  return false
}

type EnvVarConfig = {
  name: string
  required: boolean
  sensitive?: boolean // If true, value won't be logged
  validator?: (value: string) => boolean
  errorMessage?: string
}

const REQUIRED_ENV_VARS: EnvVarConfig[] = [
  // CommerceTools configuration
  { name: 'CTP_PROJECT_KEY', required: true },
  { name: 'CTP_CLIENT_ID', required: true, sensitive: true },
  { name: 'CTP_CLIENT_SECRET', required: true, sensitive: true },
  { name: 'CTP_AUTH_URL', required: true },
  { name: 'CTP_API_URL', required: true },
  { name: 'CTP_JWKS_URL', required: true },
  { name: 'CTP_JWT_ISSUER', required: true },

  // Briqpay configuration
  { name: 'BRIQPAY_USERNAME', required: true, sensitive: true },
  { name: 'BRIQPAY_SECRET', required: true, sensitive: true },
  {
    name: 'BRIQPAY_BASE_URL',
    required: true,
    validator: (value) => value.startsWith('https://'),
    errorMessage: 'BRIQPAY_BASE_URL must use HTTPS',
  },

  // URLs
  {
    name: 'BRIQPAY_TERMS_URL',
    required: true,
    validator: (value) => value.startsWith('https://'),
    errorMessage: 'BRIQPAY_TERMS_URL must use HTTPS',
  },
  {
    name: 'BRIQPAY_CONFIRMATION_URL',
    required: true,
    validator: isSecureOrLocalUrl,
    errorMessage: 'BRIQPAY_CONFIRMATION_URL must use HTTPS (except for localhost/127.0.0.1/private network IPs)',
  },
]

const OPTIONAL_ENV_VARS: EnvVarConfig[] = [
  // CORS configuration
  {
    name: 'ALLOWED_ORIGINS',
    required: false,
    validator: (value) => {
      // SECURITY: Each origin must be HTTPS or a local development URL
      // This prevents allowing arbitrary HTTP origins like http://shadywebsite.com
      const origins = value.split(',').map((o) => o.trim())
      return origins.every(isSecureOrLocalUrl)
    },
    errorMessage: 'ALLOWED_ORIGINS must be HTTPS URLs (HTTP only allowed for localhost/127.0.0.1/private network IPs)',
  },
]

export class EnvValidationError extends Error {
  constructor(
    message: string,
    public readonly missingVars: string[],
    public readonly invalidVars: string[],
  ) {
    super(message)
    this.name = 'EnvValidationError'
  }
}

function validateEnvVar(config: EnvVarConfig, checkMissing: boolean): { missing?: string; invalid?: string } {
  const value = process.env[config.name]

  if (checkMissing && (!value || value.trim() === '')) {
    return { missing: config.name }
  }

  if (value && config.validator && !config.validator(value)) {
    return { invalid: `${config.name}: ${config.errorMessage || 'Invalid value'}` }
  }

  return {}
}

function buildErrorMessage(missingVars: string[], invalidVars: string[]): string {
  const errorParts: string[] = []

  if (missingVars.length > 0) {
    errorParts.push(`Missing required environment variables: ${missingVars.join(', ')}`)
  }

  if (invalidVars.length > 0) {
    errorParts.push(`Invalid environment variables: ${invalidVars.join('; ')}`)
  }

  return errorParts.join('. ')
}

/**
 * Validates all required environment variables are present and valid.
 * @throws EnvValidationError if validation fails
 */
export function validateEnvironment(): void {
  const missingVars: string[] = []
  const invalidVars: string[] = []

  // Check required variables
  for (const config of REQUIRED_ENV_VARS) {
    const result = validateEnvVar(config, true)
    if (result.missing) missingVars.push(result.missing)
    if (result.invalid) invalidVars.push(result.invalid)
  }

  // Check optional variables (only validate if present)
  for (const config of OPTIONAL_ENV_VARS) {
    const result = validateEnvVar(config, false)
    if (result.invalid) invalidVars.push(result.invalid)
  }

  if (missingVars.length > 0 || invalidVars.length > 0) {
    throw new EnvValidationError(buildErrorMessage(missingVars, invalidVars), missingVars, invalidVars)
  }
}

/**
 * Logs environment configuration status (without sensitive values).
 * Useful for debugging deployment issues.
 */
export function logEnvironmentStatus(): void {
  const status: Record<string, string> = {}

  for (const config of [...REQUIRED_ENV_VARS, ...OPTIONAL_ENV_VARS]) {
    const value = process.env[config.name]
    if (config.sensitive) {
      status[config.name] = value ? '[SET]' : '[NOT SET]'
    } else {
      status[config.name] = value || '[NOT SET]'
    }
  }

  // eslint-disable-next-line no-console
  console.log('Environment configuration:', JSON.stringify(status, null, 2))
}
