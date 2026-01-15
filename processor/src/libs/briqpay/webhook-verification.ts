import crypto from 'crypto'
import { appLogger } from '../../payment-sdk'

/**
 * HMAC Webhook Verification for Briqpay webhooks.
 *
 * When BRIQPAY_WEBHOOK_SECRET is configured, incoming webhooks can be verified
 * using HMAC-SHA256 signatures. This provides enhanced security by:
 * 1. Confirming the webhook was sent by Briqpay
 * 2. Ensuring the payload was not tampered with
 * 3. Preventing replay attacks via timestamp validation
 */

export interface WebhookVerificationResult {
  isValid: boolean
  error?: string
}

const MAX_RECENT_SIGNATURES = 5000
const recentSignatures = new Map<string, number>()

function buildReplayKey(timestamp: string, signature: string): string {
  return crypto.createHash('sha256').update(`${timestamp}.${signature}`).digest('hex')
}

function cleanupReplayCache(now: number, toleranceMs: number): void {
  for (const [key, seenAt] of recentSignatures) {
    if (now - seenAt > toleranceMs) {
      recentSignatures.delete(key)
    }
  }
}

function isReplayDetected(signatureKey: string, timestampMs: number, now: number, toleranceMs: number): boolean {
  cleanupReplayCache(now, toleranceMs)

  if (recentSignatures.has(signatureKey)) {
    return true
  }

  recentSignatures.set(signatureKey, timestampMs)

  if (recentSignatures.size > MAX_RECENT_SIGNATURES) {
    const oldestKey = recentSignatures.keys().next().value as string | undefined
    if (oldestKey) {
      recentSignatures.delete(oldestKey)
    }
  }

  return false
}

/**
 * Parses the x-briq-signature header.
 * Format: t=<timestamp>,s1=<signature>
 *
 * @param header - The x-briq-signature header value
 * @returns Parsed timestamp and signature, or undefined if invalid
 */
function parseSignatureHeader(header: string): { timestamp: string; signature: string } | undefined {
  try {
    const parts = header.split(',')
    if (parts.length < 2) {
      return undefined
    }

    const timestampPart = parts[0]
    const signaturePart = parts[1]

    if (!timestampPart.startsWith('t=') || !signaturePart.startsWith('s1=')) {
      return undefined
    }

    // Use substring to preserve base64 padding (=) characters in signature
    const timestamp = timestampPart.substring(2)
    const signature = signaturePart.substring(3)

    if (!timestamp || !signature) {
      return undefined
    }

    return { timestamp, signature }
  } catch {
    return undefined
  }
}

/**
 * Verifies a Briqpay webhook signature using HMAC-SHA256.
 *
 * @param rawBody - The raw JSON request body as a string
 * @param signatureHeader - The x-briq-signature header value
 * @param secret - The webhook secret from the Briqpay merchant portal
 * @param toleranceMs - Maximum age of webhook in milliseconds (default: 5 minutes)
 * @returns Verification result with isValid flag and optional error message
 */
export function verifyBriqpayWebhook(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceMs: number = 5 * 60 * 1000,
): WebhookVerificationResult {
  // 1. Parse the signature header
  const parsed = parseSignatureHeader(signatureHeader)
  if (!parsed) {
    appLogger.warn({ signatureHeader }, 'Invalid signature header format')
    return { isValid: false, error: 'Invalid signature header format' }
  }

  const { timestamp, signature: receivedSignature } = parsed

  // 2. Validate timestamp to prevent replay attacks
  const timestampMs = Number(timestamp)
  if (isNaN(timestampMs)) {
    appLogger.warn({ timestamp }, 'Invalid timestamp in signature header')
    return { isValid: false, error: 'Invalid timestamp' }
  }

  const now = Date.now()
  const age = now - timestampMs
  if (age > toleranceMs) {
    appLogger.warn(
      {
        timestampMs,
        now,
        age,
        toleranceMs,
      },
      'Webhook timestamp validation failed - too old',
    )
    return { isValid: false, error: 'Timestamp validation failed - webhook too old' }
  }

  // Also reject webhooks from the future (with some small tolerance for clock skew)
  const futureToleranceMs = 60 * 1000 // 1 minute
  if (timestampMs > now + futureToleranceMs) {
    appLogger.warn(
      {
        timestampMs,
        now,
        diff: timestampMs - now,
      },
      'Webhook timestamp validation failed - from the future',
    )
    return { isValid: false, error: 'Timestamp validation failed - webhook from the future' }
  }

  // 3. Prepare the signed payload string: timestamp.body
  const signedPayload = `${timestamp}.${rawBody}`

  // 4. Compute the expected signature using HMAC-SHA256
  const expectedSignature = crypto.createHmac('sha256', secret).update(signedPayload).digest('base64')

  // 5. Compare signatures using timing-safe comparison
  try {
    const receivedBuffer = Buffer.from(receivedSignature)
    const expectedBuffer = Buffer.from(expectedSignature)

    // Buffers must be the same length for timingSafeEqual
    if (receivedBuffer.length !== expectedBuffer.length) {
      appLogger.warn(
        {
          receivedLength: receivedBuffer.length,
          expectedLength: expectedBuffer.length,
        },
        'Signature length mismatch',
      )
      return { isValid: false, error: 'Signature validation failed' }
    }

    const isValid = crypto.timingSafeEqual(receivedBuffer, expectedBuffer)

    if (!isValid) {
      appLogger.warn({}, 'Webhook signature mismatch')
      return { isValid: false, error: 'Signature validation failed' }
    }

    const replayKey = buildReplayKey(timestamp, receivedSignature)
    if (isReplayDetected(replayKey, timestampMs, now, toleranceMs)) {
      appLogger.warn({ timestampMs }, 'Webhook replay detected')
      return { isValid: false, error: 'Replay detected' }
    }

    appLogger.info({ timestampMs }, 'Webhook signature verified successfully')
    return { isValid: true }
  } catch (error) {
    appLogger.error({ error: error instanceof Error ? error.message : error }, 'Error during signature comparison')
    return { isValid: false, error: 'Signature comparison error' }
  }
}

/**
 * Checks if HMAC webhook verification is enabled.
 * Verification is enabled when BRIQPAY_WEBHOOK_SECRET is set.
 */
export function isHmacVerificationEnabled(): boolean {
  return !!process.env.BRIQPAY_WEBHOOK_SECRET
}

/**
 * Gets the webhook secret from environment.
 * Returns undefined if not configured.
 */
export function getWebhookSecret(): string | undefined {
  return process.env.BRIQPAY_WEBHOOK_SECRET
}
